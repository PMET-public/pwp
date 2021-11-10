/* eslint-disable one-var */
const fs = require('fs'),
  path = require('path'),
  puppeteer = require('puppeteer'),
  dateStr = new Date().toISOString().replace(/T.*/, ''),
  defaultBrowserWidth = 800,
  defaultBrowserHeight = 600,
  browserXPos = [0, defaultBrowserWidth, 0, defaultBrowserWidth],
  browserYPos = [0, 0, defaultBrowserHeight, defaultBrowserHeight],
  logStreams = [],
  tasks = []

  configDir = process.cwd(),
  configFile = `${configDir}/.pwp.json`,
  defaultProfileOpts = {
    'exts': [],
    'runByDefault': false,
    'devtools': false,
    'screenshot': false,
    'autoclose': true
  }

const resolveConfigPath = function (p) {
  p = p.replace('{HOME}', process.env.HOME)
  if (!/^(\.|\/)/.test(p)) { // relative path not prefixed with "./"
    p = './' + p
  }
  if (/^\.{1,2}\//.test(p)) { // relative path
    p = path.resolve(`${configDir}/${p}`)
  }
  return p
}

let numBrowsers = 0,
  task

const createProject = exports.createProject = function () {
  if (fs.existsSync(configFile)) {
    throw {code: 'EEXIST', msg: `${configFile} already exists.`}
  }
  fs.copyFileSync(`${__dirname}/../sample/.pwp.json`, `${process.cwd()}/.pwp.json`)
  return {msg: `Successfully, created sample config file: "${configFile}". Modify it for your needs.`}
}

const getConfig = function () {
  if (!fs.existsSync(configFile)) {
    throw {code: 'ENOENT', msg: `Could not find: ${configFile}. Use ${__filename} to create a project in the current directory.`}
  }
  const config = require(configFile)
  // if a tasks dir was not provided,
  if (typeof config.tasksDir === 'undefined') {
    throw {msg: `Could not find "taskDir" value in ${configFile}.`}
  }
  config.tasksDir = resolveConfigPath(config.tasksDir)
  if (!fs.existsSync(config.tasksDir)) {
    throw {msg: `Resolved tasks directory "${config.tasksDir}" does not exist.`}
  }
  return config
}

const init = function () {
  if (!fs.existsSync(config.tasksOutputDir)) {
    fs.mkdirSync(config.tasksOutputDir)
  }

  // if a tasks output dir was not provided, define default
  if (typeof config.tasksOutputDir === 'undefined') {
    config.tasksOutputDir = config.tasksDir + '/output'
  }

  config.tasksOutputDir = resolveConfigPath(config.tasksOutputDir)
  if (!fs.existsSync(config.tasksOutputDir)) {
    try {
      fs.mkdirSync(config.tasksOutputDir)
    } catch (e) {
      console.error(errorTxt(`Could not create resolved tasks output directory "${config.tasksDir}".`))
      process.exit(1)
    }
  }

  // if profiles were not provided, define default
  if (typeof config.profiles === 'undefined') {
    config.profiles = {
      // if not provided default profile should run by default
      'default': {...defaultProfileOpts, 'runByDefault': true}
    }
  } else {
    // provide default values for any omitted by user
    for (const [key, value] of Object.entries(config.profiles)) {
      config.profiles[key] = {...defaultProfileOpts, ...value}
    }
  }

  // ensure provided extensions are valid
  for (const [key, value] of Object.entries(config.profiles)) {
    let paths = config.profiles[key].exts
    if (typeof paths.forEach !== 'function') { // test if array by checking for "forEach" method
      console.error(errorTxt(`${configFile}'s profile "${key}" contains an invalid "exts" key.
  It should be an array of paths of Chrome extensions to load.`))
      process.exit(1)
    }
    paths.forEach((p, i) => {
      p = resolveConfigPath(p)
      if (!fs.existsSync(p)) {
        console.error(errorTxt(`${configFile}'s profile "${key}" contains "exts" with invalid resolved path:\n${p}.`))
        process.exit(1)
      } else {
        config.profiles[key].exts[i] = p
      }
    })
  }

  // if profile dir was not provided, define default
  if (typeof config.profilesDir === 'undefined') {
    config.profilesDir = config.tasksDir + '../.chrome-profiles'
  }

  // if profile dir does not exist, create it
  config.profilesDir = resolveConfigPath(config.profilesDir)
  if (!fs.existsSync(config.profilesDir)) {
    try {
      fs.mkdirSync(config.profilesDir)
    } catch (e) {
      console.error(errorTxt(`Could not create directory for Chrome profiles "${config.profilesDir}".`))
      process.exit(1)
    }
  }

  // after validating extensions of profiles, create chrome profile dirs if they do not exist
  for (const [key, value] of Object.entries(config.profiles)) {
    let profileDir = `${config.profilesDir}/${key}`
    if (!fs.existsSync(profileDir)) {
      try {
        fs.mkdirSync(profileDir)
      } catch (e) {
        console.error(errorTxt(`Could not create Chrome profile directory "${profileDir}".`))
        process.exit(1)
      }
    }
  }


}

const normalizeTaskSet = function(tasks) {
  const tasksGroupsToExpand = [],
    tasksToRun = []
  tasks.forEach(t => {
    if (!pwp.exportedTasks[t] && !pwp.exportedTaskGroups[t]) {
      console.error(errorTxt(`Task or group of tasks "${t}" does not exist.`))
      process.exit(1)
    }
    if (pwp.exportedTaskGroups[t]) {
      tasksGroupsToExpand[t] = true
    } else {
      tasksToRun.push(t)
    }
  })
  // iterate over ALL exported tasks to see if that task's group matches an item from the user's input
  // if so, add it (and other matches) to the list of tasks to run
  // by iterating over ALL exported tasks, only 1 loop and 1 comparison per task is needed
  for (const [key, value] of Object.entries(pwp.exportedTasks)) {
    if (tasksGroupsToExpand[value.group]) {
      tasksToRun.push(key)
    }
  }

  // dedup using sets
  const taskSet = new Set(tasksToRun)
  if (taskSet.size !== tasks.length) {
    console.log(`Filtering ... 1 or more duplicate tasks provided or within a task group. ${headerTxt('Task run order no longer guaranteed.')}`)
  }
  return taskSet
}
exports.normalizeTaskSet = normalizeTaskSet

const parseTaskFiles = exports.parseTaskFiles = function () {
  const tasks = [],
    groups = []
    config = getConfig()
  fs.readdirSync(config.tasksDir).forEach(file => {
    if (/\.js$/.test(file)) {
      taskFileExports = require(`${config.tasksDir}/${file}`)
      for (const [key, value] of Object.entries(taskFileExports)) {
        let n = value.group
        // if the task already exists or its group matches an existing task, error out
        if (tasks[key]) {
          throw {msg: `An exported task with name "${key}" already exists. Task names must be unique across all task files.`}
        } else if (tasks[n]) {
          throw {msg: `A task group with name "${key}" already exists. A task can not have the same name as an existing task group.`}
        } else {
          if (n) {
            groups[n] = n
          }
          tasks[key] = value
        }
      }
    }
  })
  if (!Object.keys(tasks).length) {
    throw {msg: `No exported tasks found in "${config.tasksDir}/*.js" file(s).`}
  }
  return {exportedTasks: tasks, exportedTaskGroups: groups}
}

const clearCookiesByProfile = function (profiles) {
  try {
    clearCookiesByProfile(p)
    fs.unlinkSync(file)
    console.log('Successfully removed ${file}')
  } catch (error) {
    if (error.code === 'ENOENT') { // do not exit with error for this case
      console.log('Does not exist or already removed.')
    } else {
      console.error(errorTxt(`Failed to remove: ${file}\n${error}`))
      process.exit(1)
    }
  }
//      await delFile(getProfileDirByMode('dev') + '/Default/Cookies', 'Delete cookies for ${}?')
}
exports.clearCookiesByProfile = clearCookiesByProfile

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

const pwp = async function(taskName, url, opts = {extMode: null}) {
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
exports.pwp = pwp

const logTask = function (taskName, url, opts, eventName, msg) {
  const path = `${config.tasksOutputDir}/${dateStr}-${taskName}-${eventName}-${opts.extMode}.log` // this naming will put relevant files side by side
  if (!logStreams[path]) {
    logStreams[path] = fs.createWriteStream(path, {flags: 'w'})
    logStreams[path].write(`Opening ${url}\n`)
  }
  msg = msg.replace(/(^200 data:[^;]+;base64,.{50}).*/, '$1') // truncate inlined binary files
  logStreams[path].write(`${msg}\n`)
}

const pwpRunner = async function (tasksToRun, profilesToRun, resolvedConfig) {
  profilesToRun.forEach(async p => {
    for (let t of tasksToRun) {
      console.log(`Running ${cmdTxt(t)} ...`)
      await exportedTasks[t].run(config)
    }
  })
}
exports.pwpRunner = pwpRunner

// await br.close()
