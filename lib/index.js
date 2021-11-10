/* eslint-disable one-var */
const fs = require('fs'),
  path = require('path'),
  puppeteer = require('puppeteer'),
  util = require('./util'),
  dateStr = new Date().toISOString().replace(/T.*/, ''),
  defaultBrowserWidth = 800,
  defaultBrowserHeight = 600,
  browserXPos = [0, defaultBrowserWidth, 0, defaultBrowserWidth],
  browserYPos = [0, 0, defaultBrowserHeight, defaultBrowserHeight],
  logStreams = [],
  tasks = [],
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
  fs.copyFileSync(`${__dirname}/../sample/.pwp.json`, `${process.cwd()}/.pwp.json`, fs.constants.COPYFILE_EXCL)
  util.copyDirSync(`${__dirname}/../sample/pwp-tasks`, `${process.cwd()}/pwp-tasks`)
  return {message: 'Successfully created sample pwp project in current directory.'}
}

const getValidatedConfig = exports.getValidatedConfig = function () {
  if (!fs.existsSync(configFile)) {
    throw {code: 'ENOENT', message: `Could not find: ${configFile}. Use ${__filename} to create a project in the current directory.`}
  }
  const config = require(configFile)
  // if a tasks dir was not provided,
  if (typeof config.tasksDir === 'undefined') {
    throw {message: `Could not find "taskDir" value in ${configFile}.`}
  }

  config.tasksDir = resolveConfigPath(config.tasksDir)
  if (!fs.existsSync(config.tasksDir)) {
    throw {message: `Resolved tasks directory "${config.tasksDir}" does not exist.`}
  }

  // if a tasks output dir was not defined, create default
  if (typeof config.tasksOutputDir === 'undefined') {
    config.tasksOutputDir = config.tasksDir + '/output'
  }
  config.tasksOutputDir = resolveConfigPath(config.tasksOutputDir)
  if (!fs.existsSync(config.tasksOutputDir)) {
    fs.mkdirSync(config.tasksOutputDir)
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
    if (typeof paths.forEach !== 'function') { // test if "paths" key is an array by checking for "forEach" method
      throw {message: `${configFile}'s profile "${key}" contains an invalid "exts" key.
It should be an array of paths of Chrome extensions to load.`}
    }
    paths.forEach((p, i) => {
      p = resolveConfigPath(p)
      if (!fs.existsSync(p)) {
        throw {message: `${configFile}'s profile "${key}" contains "exts" with invalid resolved path:\n${p}.`}
      } else {
        config.profiles[key].exts[i] = p
      }
    })
  }

  // if profile dir was not provided, define default
  if (typeof config.profilesDir === 'undefined') {
    config.profilesDir = `${config.tasksDir}/.chrome-profiles`
  }

  // if profile dir does not exist, create it
  config.profilesDir = resolveConfigPath(config.profilesDir)
  if (!fs.existsSync(config.profilesDir)) {
    fs.mkdirSync(config.profilesDir)
  }

  // after validating extensions of profiles, create chrome profile dirs if they do not exist
  for (const [key, value] of Object.entries(config.profiles)) {
    let profileDir = `${config.profilesDir}/${key}`
    if (!fs.existsSync(profileDir)) {
      try {
        fs.mkdirSync(profileDir)
      } catch (e) {
        throw {message: `Could not create Chrome profile directory "${profileDir}".`}
      }
    }
  }

  return config
}

const normalizeTaskSet = function(tasks) {
  const tasksGroupsToExpand = [],
    tasksToRun = [],
    tasksToRunFromExpandedGroups = [],
    {exportedTasks, exportedTaskGroups} = parseTaskFiles()
  tasks.forEach(t => {
    if (!exportedTasks[t] && !exportedTaskGroups[t]) {
      throw {message: `Task or group of tasks "${t}" does not exist.`}
    }
    if (exportedTaskGroups[t]) {
      tasksGroupsToExpand[t] = true
    } else {
      tasksToRun.push(t)
    }
  })
  // iterate over ALL exported tasks to see if that task's group matches an item from the user's input
  // if so, add it (and other matches) to the list of tasks to run
  // by iterating over ALL exported tasks, only 1 loop and 1 comparison per task is needed
  for (const [key, value] of Object.entries(exportedTasks)) {
    if (tasksGroupsToExpand[value.group]) {
      tasksToRunFromExpandedGroups.push(key)
    }
  }

  // dedup using sets
  const taskSet = new Set([...tasksToRunFromExpandedGroups, ...tasksToRun])
  if (taskSet.size !== tasksToRunFromExpandedGroups.length + tasksToRun.length) {
    console.log(`Filtering ... 1 or more duplicate tasks provided or part of a task group. ${headerTxt('Task run order no longer guaranteed.')}`)
  }
  return taskSet
}

const parseTaskFiles = exports.parseTaskFiles = function () {
  const tasks = [],
    groups = [],
    config = getValidatedConfig()
  fs.readdirSync(config.tasksDir).forEach(file => {
    if (/\.js$/.test(file)) {
      taskFileExports = require(`${config.tasksDir}/${file}`)
      for (const [key, value] of Object.entries(taskFileExports)) {
        let n = value.group
        // if the task already exists or its group matches an existing task, error out
        if (tasks[key]) {
          throw {message: `An exported task with name "${key}" already exists. Task names must be unique across all task files.`}
        } else if (tasks[n]) {
          throw {message: `A task group with name "${key}" already exists. A task can not have the same name as an existing task group.`}
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
    throw {message: `No exported tasks found in "${config.tasksDir}/*.js" file(s).`}
  }
  return {exportedTasks: tasks, exportedTaskGroups: groups}
}

const runTasks = exports.runTasks = function (tasksToRun, profilesToRun, profileOverrideOpts) {
  tasksToRun = normalizeTaskSet(tasksToRun)
  const config = getValidatedConfig()

  // if no profiles were passed via the cli, check the config for profiles to run by default
  if (!profilesToRun.length) {
    for (const [key, value] of Object.entries(config.profiles)) {
      if (config.profiles[key].runByDefault) {
        profilesToRun.push(key)
      }
    }
  }

  // override .pwp.json config with cmd line options
  profilesToRun.forEach(p => {
    if (typeof profileOverrideOpts.screenshot !== 'undefined') {
      config.profiles[p].screenshot = profileOverrideOpts.screenshot
    }
    if (typeof profileOverrideOpts.autoclose !== 'undefined') {
      config.profiles[p].autoclose = profileOverrideOpts.autoclose
    }
    if (typeof profileOverrideOpts.devtools !== 'undefined') {
      config.profiles[p].devtools = profileOverrideOpts.devtools
    }
  })

  // if too many profiles could crash as try to run many browsers at the same time
  profilesToRun.forEach(async p => {
    for (let t of tasksToRun) {
      console.log(`Running ${cmdTxt(t)} ...`)
      await exportedTasks[t].run(config)
    }
  })
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

// await br.close()
