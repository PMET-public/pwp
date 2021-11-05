/* eslint-disable one-var */
const fs = require('fs'),
  puppeteer = require('puppeteer'),
  prodExtPath = `${process.env.HOME}/Library/Application Support/Google/Chrome/Default/Extensions/onibnnoghllldiecboelbpcaeggfiohl/5.4.6_0`,
  devExtPath = `${__dirname}/../dist/chrome-extension`,
  dateStr = new Date().toISOString().replace(/T.*/, ''),
  defaultBrowserWidth = 800,
  defaultBrowserHeight = 600,
  browserXPos = [0, defaultBrowserWidth, 0, defaultBrowserWidth],
  browserYPos = [0, 0, defaultBrowserHeight, defaultBrowserHeight],
  logStreams = [],
  tasks = [],
  outputDir = `${__dirname}/../output`

let numBrowsers = 0,
  task

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir)
}

const getProfileDirByMode = function (mode) {
  return `${process.env.HOME}/.chromium-marketo-test-${mode}-mode`
}
exports.getProfileDirByMode = getProfileDirByMode

const browserWithMLExt = async function(url, opts) {
  numBrowsers++
  let args = [
      '--disable-fre',
      '--disable-infobars',
      '--no-default-browser-check',
      '--no-first-run',
      //`--window-size=${defaultBrowserWidth},${defaultBrowserHeight}`,
      //`--window-position=${browserXPos[numBrowsers - 1]},${browserYPos[numBrowsers - 1]}`,
      //'--window-workspace=-2',
    ], launchOpts = {
      headless: false,
      defaultViewport: null,
      args: args
      // dumpio: true
    }
  if (opts.extMode !== null) {
    let pathToExtension = opts.extMode === 'prod' ? prodExtPath : devExtPath
    if (!fs.existsSync(pathToExtension)) {
      throw 'Path to extension does not exist!'
    }
    args.push(`--disable-extensions-except=${pathToExtension}`, `--load-extension=${pathToExtension}`)
  }
  // if a clean (new) profile has not been requested, reuse one based on the extMode
  if (!opts.cleanProfile) {
    let userDataDir = getProfileDirByMode(opts.extMode),
      userDataDirPrefsFile = `${userDataDir}/Default/Preferences`
    if (fs.existsSync(userDataDirPrefsFile)) {
      // clean up any previously crashed session to prevent unwanted warning msg
      // https://raspberrypi.stackexchange.com/questions/68734/how-do-i-disable-restore-pages-chromium-didnt-shut-down-correctly-prompt
      prefs = fs.readFileSync(userDataDirPrefsFile, {encoding: 'utf8'})
      prefs = prefs.replace('"exit_type":"Crashed"', '"exit_type":"Normal"')
      fs.writeFileSync(userDataDirPrefsFile, prefs)
    }
    launchOpts = {...launchOpts, userDataDir: userDataDir}
  }
  args.push(url)
  return await puppeteer.launch(launchOpts)
}

const loggingTaskPage = async function(taskName, url, opts = {extMode: 'dev'}) {
  let logTaskArgs = [taskName, url, opts.extMode || opts.extMode === null ? opts : {...opts, extMode: 'dev'}], // account for case where opts were passed but extMode not set
    br = await browserWithMLExt(url, opts),
    targets = await br.targets(),
    pageTarget = targets.find(target => target.type() === 'page'),
    page = await pageTarget.page()
  page.on('console', message => logTask(...logTaskArgs, 'console', `${message.type().substr(0, 3).toUpperCase()} ${message.text()}`))
    .on('pageerror', ({ message }) => logTask(...logTaskArgs, 'pageerror', message))
    .on('response', response => logTask(...logTaskArgs, 'response', `${response.status()} ${response.url()}`))
    .on('requestfailed', request => logTask(...logTaskArgs, 'requestfailed', `${request.failure().errorText} ${request.url()}`))
  let backgroundPageTarget = targets.find(target => target.type() === 'background_page')
  if (backgroundPageTarget) { // account for no extension loaded
    let backgroundPage = await backgroundPageTarget.page()
    backgroundPage.on('console', message => logTask(...logTaskArgs, 'bckgrnd-console', `${message.type().substr(0, 3).toUpperCase()} ${message.text()}`))
      .on('pageerror', ({ message }) => logTask(...logTaskArgs, 'bckgrnd-pageerror', message))
      .on('response', response => logTask(...logTaskArgs, 'bckgrnd-response', `${response.status()} ${response.url()}`))
      .on('requestfailed', request => logTask(...logTaskArgs, 'bckgrnd-requestfailed', `${request.failure().errorText} ${request.url()}`))
  }
  return page
}
exports.loggingTaskPage = loggingTaskPage

const logTask = function (taskName, url, opts, eventName, msg) {
  const path = `${outputDir}/${dateStr}-${taskName}-${eventName}-${opts.extMode}.log` // this naming will put relevant files side by side
  if (!logStreams[path]) {
    logStreams[path] = fs.createWriteStream(path, {flags: 'w'})
    logStreams[path].write(`Opening ${url}\n`)
  }
  msg = msg.replace(/(^200 data:[^;]+;base64,.{50}).*/, '$1') // truncate inlined binary files
  logStreams[path].write(`${msg}\n`)
}

// await br.close()
