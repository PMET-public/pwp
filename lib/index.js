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
    'screenshot': true,
    'autoclose': true
  }

const resolveConfigPath = function (p) {
  p = p.replace(/^~\//, `${process.env.HOME}/`)
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

// by taking parseTaskFilesResultObj, we can avoid parsing task files multiple times
const normalizeTaskSet = function(tasks, parseTaskFilesResultObj) {
  const tasksGroupsToExpand = [],
    tasksToRun = [],
    tasksToRunFromExpandedGroups = [],
    {exportedTasks, exportedTaskGroups} = parseTaskFilesResultObj
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

const runTasks = exports.runTasks = function (tasksToRun, profilesToRun, maxConcurrentProfiles, url, profileOverrideOpts) {
  const {exportedTasks, exportedTaskGroups} = parseTaskFiles(),
    config = getValidatedConfig()
  tasksToRun = normalizeTaskSet(tasksToRun, {exportedTasks, exportedTaskGroups})

  // if no profiles were passed via the cli, check the config for profiles to run by default
  if (!profilesToRun.length) {
    for (const [key, value] of Object.entries(config.profiles)) {
      if (config.profiles[key].runByDefault) {
        profilesToRun.push(key)
      }
    }
    // still no run by default profiles found, use blank profile
    if (!profilesToRun.length) {
      profilesToRun.push('PWP_BLANK_PROFILE')
    }
  }

  // set default values if omitted by user in config
  // then override with cmd line options if present
  profilesToRun.forEach(p => {
    config.profiles[p] = {...defaultProfileOpts, ...config.profiles[p]}
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
  profilesToRun.forEach(async profile => {
    let page, browser
    for (let taskName of tasksToRun) {
      console.log(`Running ${cmdTxt(taskName)} ...`)
      let task = exportedTasks[taskName]

      // if an existing browser & page from the prev task, reuse it
      browser = browser ? browser : await launchBrowserWithOpts(config, profile)
      page = page ? page : await startPageLogging({browser: browser, task: taskName, profile: profile})

      if (!url) { 
        // if no url param, use the task.url
        // if that's undefined, then use the cur page
        url = task.url ? task.url : page.url()
      }
      if (url !== page.url()) {
        // only goto a url if it's new
        await page.goto(url)
      }
      await task.run(page)
      if (config.profiles[profile].screenshot) {
        await page.screenshot({
          path: `${config.tasksOutputDir}/${dateStr}.png`
        })
      }
    }
    if (config.profiles[profile].autoclose) {
      await browser.close()
    }

  })
}

const clearCookiesByProfile = exports.clearCookiesByProfile = function (profile) {
  try {
    const config = getValidatedConfig(),
      profileDir = `${config.profilesDir}/${profile}`
    fs.unlinkSync( `${profileDir}/Default/Cookies`)
    console.log('Successfully removed ${file}')
  } catch (error) {
    if (error.code === 'ENOENT') { // do not exit with error for this case
      console.log('Cookies file does not exist or already removed.')
    } else {
      throw {message: `Failed to remove: ${file}\n${error}`}
    }
  }
}

const recoverPrefsFileIfPrevCrash = function (prefsFile) {
  if (fs.existsSync(prefsFile)) {
    // clean up any previously crashed session to prevent unwanted warning msg
    // https://raspberrypi.stackexchange.com/questions/68734/how-do-i-disable-restore-pages-chromium-didnt-shut-down-correctly-prompt
    prefs = fs.readFileSync(prefsFile, {encoding: 'utf8'})
    prefs = prefs.replace('"exit_type":"Crashed"', '"exit_type":"Normal"')
    fs.writeFileSync(prefsFile, prefs)
  }
}

const launchBrowserWithOpts = async function(config, profile) {
  numBrowsers++
  let args = [
      '--disable-fre',
      '--disable-infobars',
      '--no-default-browser-check',
      '--no-first-run',
      //`--window-size=${defaultBrowserWidth},${defaultBrowserHeight}`,
      //`--window-position=${browserXPos[numBrowsers - 1]},${browserYPos[numBrowsers - 1]}`,
      //'--window-workspace=-2',
    ],
    launchOpts = {
      headless: false,
      defaultViewport: null,
      args: args
      // dumpio: true
    }
  let pathsToExtension = config.profiles[profile].exts.join(',')
  if (pathsToExtension) {
    args.push(`--disable-extensions-except=${pathsToExtension}`, `--load-extension=${pathsToExtension}`)
  }

  // if a clean (new) profile has not been requested, reuse one based on the extMode
  if (profile !== 'PWP_BLANK_PROFILE') {
    recoverPrefsFileIfPrevCrash(`${config.profilesDir}/${profile}/Default/Preferences`)
    launchOpts = {...launchOpts, userDataDir: `${config.profilesDir}/${profile}`}
  }
  // args.push(url) // remove?
  return puppeteer.launch(launchOpts)
}

const startPageLogging = async function (opts) {
  const {browser, task, profile} = opts,
    targets = await browser.targets(),
    pageTarget = targets.find(target => target.type() === 'page'),
    page = await pageTarget.page()
  page.on('console', message => logEventMsg(opts, 'console', `${message.type().substr(0, 3).toUpperCase()} ${message.text()}`))
    .on('pageerror', ({ message }) => logEventMsg(opts, 'pageerror', message))
    .on('response', response => logEventMsg(opts, 'response', `${response.status()} ${response.url()}`))
    .on('requestfailed', request => logEventMsg(opts, 'requestfailed', `${request.failure().errorText} ${request.url()}`))
  let backgroundPageTarget = targets.find(target => target.type() === 'background_page')
  if (backgroundPageTarget) { // account for no extension loaded
    let backgroundPage = await backgroundPageTarget.page()
    backgroundPage.on('console', message => logEventMsg(opts, 'bckgrnd-console', `${message.type().substr(0, 3).toUpperCase()} ${message.text()}`))
      .on('pageerror', ({ message }) => logEventMsg(opts, 'bckgrnd-pageerror', message))
      .on('response', response => logEventMsg(opts, 'bckgrnd-response', `${response.status()} ${response.url()}`))
      .on('requestfailed', request => logEventMsg(opts, 'bckgrnd-requestfailed', `${request.failure().errorText} ${request.url()}`))
  }
  return page
}

// const loggedPageEvent = ['console', 'pageerror', 'response', 'requestfailed']
// const loggedBckgrndPageEvent = ['console', 'pageerror', 'response', 'requestfailed']

const logEventMsg = function (opts, event, msg) {
  // this file naming convention will put files that you will likely want to compare side by side
  // i.e. when sorted by alpha, log files will be grouped by task name, then event, then profile
  // and diffs between profiles of the same task & event are generally most relevant
  const {task, profile} = opts,
    config = getValidatedConfig(),
    path = `${config.tasksOutputDir}/${dateStr}-${task}-${event}-${profile}.log`
  if (!logStreams[path]) {
    logStreams[path] = fs.createWriteStream(path, {flags: 'w'})
    // logStreams[path].write(`Opening ${url}\n`) // this should be passed as a msg
  }
  msg = msg.replace(/(^200 data:[^;]+;base64,.{50}).*/, '$1') // truncate inlined binary files
  logStreams[path].write(`${msg}\n`)
}
