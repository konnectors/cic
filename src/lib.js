const {
  requestFactory,
  updateOrCreate,
  log,
  errors,
  categorize,
  cozyClient
} = require('cozy-konnector-libs')
const groupBy = require('lodash/groupBy')
const omit = require('lodash/omit')
const pick = require('lodash/pick')
const moment = require('moment')
const xlsx = require('xlsx')
const cheerio = require('cheerio')
const { CookieJar } = require('tough-cookie')
const JAR_ACCOUNT_KEY = 'cookie_twofactor'

const helpers = require('./helpers')
const BankUrl = require('./urlBuilder')

const doctypes = require('cozy-doctypes')
const {
  BankAccount,
  BankTransaction,
  BalanceHistory,
  BankingReconciliator
} = doctypes

BankAccount.registerClient(cozyClient)
BalanceHistory.registerClient(cozyClient)
BankTransaction.registerClient(cozyClient)

let jar = requestFactory().jar()

const reconciliator = new BankingReconciliator({ BankAccount, BankTransaction })
const request = requestFactory({
  cheerio: true,
  json: false,
  jar: jar
})

let lib
let self

/**
 * The start function is run by the BaseKonnector instance only when it got all the account
 * information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
 * the account information come from ./konnector-dev-config.json file
 * @param {object} fields
 */
async function start(fields) {
  log('info', 'Build urls')
  self = this

  if (!fields.language) {
    throw new Error('Missing fields.language...')
  }

  BankUrl.setLanguage(fields.language)

  log('info', BankUrl.getHost(), 'Base url')

  // ---

  // Get 2FA token from account data
  const accountData = this.getAccountData()
  let auth2FAToken = getTwoFactorCookie(accountData)

  if (auth2FAToken) {
    log('info', 'found saved 2FA token, using it...')
    jar._jar = CookieJar.fromJSON(auth2FAToken)
  }

  // ---

  log('info', 'Authenticating ...')
  this.deactivateAutoSuccessfulLogin()
  let is_auth = await authenticate(fields.login, fields.password)
  if (!is_auth) {
    throw new Error(errors.LOGIN_FAILED)
  }
  log('info', 'Successfully logged in')
  await this.notifySuccessfulLogin()

  log(
    'info',
    'Retrieve the Excel file containing the list of bank accounts and transactions'
  )
  let workbook = await downloadExcelWithBankInformation()

  log('info', 'Parsing list of bank accounts')
  let worksheet = workbook.Sheets[workbook.SheetNames[0]]
  let lines = xlsx.utils.sheet_to_csv(worksheet, { FS: ';' }).split('\n')
  const bankAccounts = await lib.parseBankAccounts(lines)

  log('info', 'Parsing list of transactions by bank account')
  let allOperations = []
  bankAccounts.forEach(account => {
    let sheetName = 'Cpt ' + account.rawNumber.replace('30027', '').trim()
    worksheet = workbook.Sheets[sheetName]

    if (!worksheet) {
      log('error', sheetName, 'No sheet found')
    } else {
      log('debug', 'Parsing list of transactions', sheetName)
      let lines = xlsx.utils.sheet_to_csv(worksheet, { FS: ';' }).split('\n')
      allOperations = allOperations.concat(lib.parseOperations(account, lines))
    }
  })

  log('info', 'Categorize the list of transactions')
  const categorizedTransactions = await categorize(allOperations)

  const { accounts: savedAccounts } = await reconciliator.save(
    bankAccounts.map(x => omit(x, ['currency'])),
    categorizedTransactions
  )

  log(
    'info',
    'Retrieve the balance histories and adds the balance of the day for each bank accounts'
  )
  const balances = await fetchBalances(savedAccounts)

  log('info', 'Save the balance histories')
  await lib.saveBalances(balances)
}

// ============

function getTwoFactorCookie(accountData) {
  if (accountData && accountData.auth && accountData.auth[JAR_ACCOUNT_KEY]) {
    return JSON.parse(accountData.auth[JAR_ACCOUNT_KEY])
  }
  return null
}

/**
 * This function initiates a connection on the CIC website.
 *
 * @param {string} user
 * @param {string} password
 * @returns {boolean} Returns true if authentication is successful, else false
 * @throws {Error} When the website is down or an HTTP error has occurred
 */
function authenticate(user, password) {
  return request({
    uri: BankUrl.get('auth'),
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    // HACK: Form option doesn't.html correctly encode values.
    body:
      '_cm_user=' + escape(user) + '&flag=password&_cm_pwd=' + escape(password),
    transform: (body, response) => [
      response.statusCode,
      cheerio.load(body),
      response
    ]
  })
    .then(([statusCode, $, fullResponse]) => {
      let currentUrl = fullResponse.request.uri.href
      switch (currentUrl) {
        // Redirect to 2FA
        case BankUrl.get('auth2FA'):
          log('info', 'Two factor authentication required')
          return twoFactorAuthentication($)

        // Redirect to same page (auth)
        case BankUrl.get('auth'):
          log(
            'error',
            statusCode + ' ' + $('.blocmsg.err').text(),
            errors.LOGIN_FAILED
          )
          throw new Error(errors.LOGIN_FAILED)

        // Redirect to home page
        case BankUrl.get('home'):
        case BankUrl.get('home') + fullResponse.request.uri.search:
          log('debug', 'Redirected to home page')
          return true
      }

      log('error', 'Redirected to ' + currentUrl + ' instead of home page')
      throw new Error(errors.USER_ACTION_NEEDED)
    })
    .catch(err => {
      if (err.statusCode && err.statusCode >= 500) {
        throw new Error(errors.VENDOR_DOWN)
      }

      throw err
    })
}

/**
 * This function handles the two factor authentication challenge implemented with DSP2 directive.
 *
 * An user action is required to validate the authentication. That's why this function
 * watchs every 5 seconds if the user has validated the connection. If so, the twoFactorCookie will
 * save for future authentication.
 *
 * @param {object} $
 * @param {object} fullResponse
 * @returns {boolean} Returns true if authentication is successful, else false
 * @throws {Error} When the website is down or an HTTP error has occurred
 */
async function twoFactorAuthentication($) {
  let textScripts = ''
  let fields = {}

  // Check if the website asks to confirm our identity
  let askConfirmIdentity = $(
    'a[href="/' + BankUrl.get('authConfirmIdentity') + '"]'
  )

  if (askConfirmIdentity.length) {
    log('info', 'The website asks to confirm the identity')
    // eslint-disable-next-line require-atomic-updates
    $ = await confirmIdentify()
  }

  // Get URL OTP validation from form, because the url contains a token
  let urlOTPValidation = ''

  let form = $('form')
  form.each((index, element) => {
    let action = $(element).attr('action')
    if (action.includes('validation.aspx')) {
      urlOTPValidation = BankUrl.getBaseUrl() + action
    }
  })

  let inputs = $('input')
  let scripts = $('.OTPDeliveryChannelText script:not([src])')
  let regex = /transactionId:\s+'(.+?)',/im

  inputs.each((index, element) => {
    let name = $(element).attr('name')
    if (name !== undefined) {
      fields[name] = $(element).val()
    }
  })

  fields = pick(fields, ['otp_hidden', '_wxf2_cc'])
  fields['_FID_DoValidate.x'] = 0
  fields['_FID_DoValidate.y'] = 0

  scripts.each((index, element) => (textScripts += $(element).html()))

  let matches = regex.exec(textScripts)

  if (matches.length < 1) {
    // transactionId not found
    return false
  }

  let timeout = 15000 // Wait 15s before the first checking
  let transactionID = matches[1]

  // 60 * 5 = 300s (5 min)
  for (let t = 0; t < 60; t++) {
    log(
      'info',
      'Wait few seconds before to check if the two factor challenge has been validated'
    )

    // Wait 5 seconds
    await new Promise(done => setTimeout(done, timeout))
    timeout = 5000 // For the next try, wait just 5 seconds

    let authenticated = await request({
      uri: BankUrl.get('authOTP'),
      method: 'POST',
      form: {
        transactionId: transactionID
      },
      transform: body => cheerio.load(body)
    }).then(async function($) {
      let transactionState = $('transactionState').text()
      log('info', 'Status of 2FA challenge : ' + transactionState)

      if (
        transactionState === 'VALIDATED' ||
        transactionState === 'validated'
      ) {
        return await validationOTP(urlOTPValidation, fields)
      }
      return false
    })

    if (authenticated) {
      return true
    }
  }

  return false
}

function validationOTP(urlOTPValidation, fields) {
  return request({
    uri: urlOTPValidation,
    method: 'POST',
    form: fields,
    transform: (body, response) => [response]
  }).then(([fullResponse]) => {
    saveCookies()

    let uri = fullResponse.request.uri

    // Add query part (uri.search) from uri to check the target page and avoid false negative
    if (uri.href !== (BankUrl.get('home') + uri.search) ) {
      // If the URI is different to urlHome, that means there is probably a user action
      throw new Error(errors.USER_ACTION_NEEDED)
    }

    return true
  })
}

async function confirmIdentify() {
  return await request({
    uri: BankUrl.get('authConfirmIdentity'),
    method: 'GET',
    transform: body => cheerio.load(body)
  }).then(function($) {
    return $
  })
}

async function saveCookies() {
  let cookies = jar._jar.toJSON()
  cookies.cookies = cookies.cookies.filter(
    obj => obj.key == 'auth_client_state'
  )

  const data = self.getAccountData()
  const accountData = { ...data, auth: {} }
  accountData.auth[JAR_ACCOUNT_KEY] = JSON.stringify(cookies)
  await self.saveAccountData(accountData)
  log('info', 'saved the session')
}

/**
 * Downloads an Excel file containing all bank accounts and recent transactions
 * on each bank accounts.
 *
 * @returns {xlsx.WorkBook} Workbook downloaded from CIC website. It contains all bank accounts
 * and recent transactions on each bank account.
 */
async function downloadExcelWithBankInformation() {
  const rq = requestFactory({
    cheerio: false,
    gzip: false,
    jar: jar
  })

  return rq({
    uri: BankUrl.get('xlsxDownload'),
    encoding: 'binary'
  }).then(body => {
    return body.Sheets ? body : xlsx.read(body, { type: 'binary' })
  })
}

/**
 * Parses and transforms each lines (CSV format) into
 * {@link https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankaccounts|io.cozy.bank.accounts}
 * @param {array} bankAccountLines Lines containing the bank account information - CSV format expected
 * @example
 * var csv = [
 *   '...',';;;','Compte;R.I.B.;Solde;Dev', // ignored
 *   // Bank accounts
 *   'LIVRET;XXXXXXXX;42;EUR'
 * ];
 *
 * parseBankAccounts(csv);
 *
 * // [
 * //   {
 * //     institutionLabel: 'CIC',
 * //     label: 'LIVRET',
 * //     type: 'Savings',
 * //     balance: 42,
 * //     number: 'XXXXXXXX',
 * //     vendorId: 'XXXXXXXX',
 * //     rawNumber: 'XXXXXXXX',
 * //     currency: 'EUR'
 * //   }
 * // ]
 *
 * @returns {array} Collection of
 * {@link https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankaccounts|io.cozy.bank.accounts}
 */
function parseBankAccounts(bankAccountLines) {
  return bankAccountLines
    .slice(3)
    .filter(line => {
      return line.length > 5 // avoid lines with empty cells
    })
    .map(line => {
      const cells = line.split(';')
      const number = cells[1].replaceAll(/\s/, '')

      return {
        institutionLabel: 'CIC',
        label: cells[0],
        type: helpers.parseLabelBankAccount(cells[0]),
        balance: helpers.normalizeAmount(cells[2]),
        number: number,
        vendorId: number,
        rawNumber: cells[1],
        currency: cells[3]
      }
    })
}

/**
 * Parses and transforms each lines (CSV format) into
 * {@link https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankoperations|io.cozy.bank.operations}
 * @param {io.cozy.bank.accounts} account Bank account
 * @param {array} operationLines Lines containing operation information for the current bank account - CSV format expected
 *
 * @example
 * var account = {
 *    institutionLabel: 'CIC',
 *    label: 'LIVRET',
 *    type: 'Savings',
 *    balance: 42,
 *    number: 'XXXXXXXX',
 *    vendorId: 'XXXXXXXX',
 *    rawNumber: 'XXXXXXXX',
 *    currency: 'EUR'
 * };
 *
 * var csv = [
 *    '...', '...','...','...','Date;Valeur;Libellé;Débit;Crédit;Solde', // ignored
 *    // Transaction(s)
 *    '12/31/18;1/1/19;INTERETS 2018;;38.67 €;',
 *    // End transaction(s)
 *    '...','...','...','' // ignored
 * ];
 *
 * parseOperations(account, csv);
 * // [
 * //   {
 * //     label: 'INTERETS 2018',
 * //     type: 'direct debit',
 * //     cozyCategoryId: '200130',
 * //     cozyCategoryProba: 1,
 * //     date: "2018-12-30T23:00:00+01:00",
 * //     dateOperation: "2018-12-31T23:00:00+01:00",
 * //     dateImport: "2019-04-17T10:07:30.553Z",       (UTC)
 * //     currency: 'EUR',
 * //     vendorAccountId: 'XXXXXXXX',
 * //     amount: 38.67,
 * //     vendorId: 'XXXXXXXX_2018-12-30_0'             {number}_{date}_{index}
 * //   }
 *
 * @returns {array} Collection of {@link https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankoperations|io.cozy.bank.operations}.
 */
function parseOperations(account, operationLines) {
  const operations = operationLines
    .slice(5, operationLines.length - 3)
    .filter(line => {
      return line.length > 5 // avoid lines with empty cells
    })
    .map(line => {
      const cells = line.split(';')
      const labels = cells[2].split(' ')
      let metadata = null

      const date = helpers.parseDate(cells[0])
      const dateOperation = helpers.parseDate(cells[1])

      let amount = 0
      if (cells[3].length) {
        amount = helpers.normalizeAmount(cells[3])
        metadata = helpers.findMetadataForDebitOperation(labels)
      } else if (cells[4].length) {
        amount = helpers.normalizeAmount(cells[4])
        metadata = helpers.findMetadataForCreditOperation(labels)
      } else {
        log('error', cells, 'Could not find an amount in this operation')
      }

      return {
        label: cells[2],
        type: metadata._type || 'none',
        date: date.format(),
        dateOperation: dateOperation.format(),
        dateImport: new Date().toISOString(),
        currency: account.currency,
        vendorAccountId: account.number,
        amount: amount
      }
    })

  // Forge a vendorId by concatenating account number, day YYYY-MM-DD and index
  // of the operation during the day
  const groups = groupBy(operations, x => x.date.slice(0, 10))
  Object.entries(groups).forEach(([date, group]) => {
    group.forEach((operation, i) => {
      operation.vendorId = `${account.vendorId.replaceAll(
        /\s/,
        '_'
      )}_${date}_${i}`
    })
  })

  return operations
}

/**
 * Retrieves the balance history for one year and an account. If no balance history is found,
 * this function returns an empty document based on {@link https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankbalancehistories|io.cozy.bank.balancehistories} doctype.
 * <br><br>
 * Note: Can't.html use <code>BalanceHistory.getByYearAndAccount()</code> directly for the moment,
 * because <code>BalanceHistory</code> invokes <code>Document</code> that doesn't.html have an cozyClient instance.
 *
 * @param {integer} year
 * @param {string} accountId
 * @returns {io.cozy.bank.balancehistories} The balance history for one year and an account.
 */
async function getBalanceHistory(year, accountId) {
  const index = await BalanceHistory.getIndex(
    BalanceHistory.doctype,
    BalanceHistory.idAttributes
  )
  const options = {
    selector: { year, 'relationships.account.data._id': accountId },
    limit: 1
  }
  const [balance] = await BalanceHistory.query(index, options)

  if (balance) {
    return balance
  }

  return BalanceHistory.getEmptyDocument(year, accountId)
}

/**
 * Retrieves the balance histories of each bank accounts and adds the balance of the day for each bank account.
 * @param {array} accounts Collection of {@link https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankaccounts|io.cozy.bank.accounts}
 * already registered in database
 *
 * @example
 * var accounts = [
 *    {
 *      _id: '12345...',
 *      _rev: '14-98765...',
 *      _type: 'io.cozy.bank.accounts',
 *      balance: 42,
 *      cozyMetadata: { updatedAt: '2019-04-17T10:07:30.769Z' },
 *      institutionLabel: 'CIC',
 *      label: 'LIVRET',
 *      number: 'XXXXXXXX',
 *      rawNumber: 'XXXXXXXX',
 *      type: 'Savings',
 *      vendorId: 'XXXXXXXX'
 *    }
 * ];
 *
 *
 * fetchBalances(accounts);
 *
 * // [
 * //   {
 * //     _id: '12345...',
 * //     _rev: '9-98765...',
 * //     balances: { '2019-04-16': 42, '2019-04-17': 42 },
 * //     metadata: { version: 1 },
 * //     relationships: { account: [Object] },
 * //     year: 2019
 * //   }
 * // ]
 *
 * @returns {array} Collection of {@link https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankbalancehistories|io.cozy.bank.balancehistories}
 * registered in database
 */
function fetchBalances(accounts) {
  const now = moment()
  const todayAsString = now.format('YYYY-MM-DD')
  const currentYear = now.year()

  return Promise.all(
    accounts.map(async account => {
      const history = await getBalanceHistory(currentYear, account._id)
      history.balances[todayAsString] = account.balance

      return history
    })
  )
}

/**
 * Saves the balance histories in database.
 *
 * @param balances Collection of {@link https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankbalancehistories|io.cozy.bank.balancehistories}
 * to save in database
 * @returns {Promise}
 */
function saveBalances(balances) {
  return updateOrCreate(balances, 'io.cozy.bank.balancehistories', ['_id'])
}

// ===== Export ======

String.prototype.replaceAll = function(search, replacement) {
  var target = this
  return target.replace(new RegExp(search, 'g'), replacement)
}

module.exports = lib = {
  start,
  authenticate,
  parseBankAccounts,
  parseOperations,
  fetchBalances,
  saveBalances
}
