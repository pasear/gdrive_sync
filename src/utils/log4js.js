const log4js = require('log4js');
const { logger } = require('config');

log4js.configure(logger);
module.exports = log4js;
