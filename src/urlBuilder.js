const log = require('cozy-logger').namespace('CIC/URLBuilder');

const baseUrl = 'https://www.cic.fr/'

const basePathAuth = 'banque/validation.aspx'
const basePathDocument = 'banque/documentinternet.html'

const paths = {
  home: `banque/pageaccueil.html`,
  auth: `authentification.html`,
  auth2FA: basePathAuth,
  authOTP: `otp/SOSD_OTP_GetTransactionState.htm`,
  authConfirmIdentity: `${basePathAuth}?_tabi=C&_pid=AuthChoicePage&_fid=SCA`,
  xlsxDownload: `banque/compte/routetelechargement.asp?formatTelechargement=XL&compte=all`
}

class URLBuilder {
  constructor() {
    this.setLanguage('fr')
  }

  getLanguage() {
    return this.language
  }

  setLanguage(language) {
    this.language = language
  }

  getBaseUrl() {
    return baseUrl
  }

  getHost() {
    return baseUrl + this.language + '/'
  }

  get(key) {
    if (paths[key]) return this.getHost() + paths[key]

    log('warn', 'No URL found for :' + key)
    return undefined
  }
}

const BankUrl = new URLBuilder()
module.exports = BankUrl
