#!/usr/bin/env node

// File used to setup the pwp cli for a project
// - looks for a .pwp.json
// - resolves config between user and defaults
// - validates config
// - interacts with user for certain commands

/* eslint-disable one-var */
const yargs = require('yargs'),
  chalk = require('chalk'),
  readline = require('readline'),
  pwp = require('../lib/index'), // when actively debugging
  // pwp = require('pwp'), // when used as module
  errorTxt = txt => chalk.bold.white.bgRed(txt),
  warningTxt = headerTxt = txt => chalk.yellow(txt),
  successTxt = cmdTxt = txt => chalk.green(txt),
  fadeTxt = txt => chalk.grey(txt)

yargs.command(
  ['new-project'],
  'Create a new pwp project with sample config in the current directory',
  () => {},
  argv => {
    try {
      const result = pwp.createProject()
      console.log(successTxt(result.msg))
    } catch (error) {
      console.error(errorTxt(error.msg))
      process.exit(1)
    }
  }
)

yargs.command(
  ['list'],
  'Show list of tasks',
  () => {},
  argv => {
    try {
      const {exportedTasks} = pwp.parseTaskFiles()
      let group
      for (const [key, value] of Object.entries(exportedTasks)) {
        if (group !== value.group) {
          ({group} = value)
          console.log('\n' + headerTxt(value.group))
        }
        console.log(`    ${cmdTxt(key)}: ${value.description ? value.description : fadeTxt('no description provided')}`)
      }
    } catch (error) {
      console.error(errorTxt(error.msg))
      process.exit(1)
    }

  }
)

const addProfilesOpt = function (yargs) {
  yargs.option('p', {
    alias: 'profiles',
    description: 'list of profiles',
    choices: Object.keys(config.profiles),
    // yargs returns a single "choice" as a string but multiple choices as an array. make it consistent.
    coerce: x => typeof x === "string" ? [x] : x
  })
}

yargs.command(
  ['run [tasks...]'],
  'Run a list of tasks with the specified options',
  yargs => {
    addProfilesOpt(yargs)
    yargs.option('screenshot',{
      description: 'Screenshot the page after each task is run. Use --no- prefix to negate.',
      global: false,
      type: 'boolean'
    })
    yargs.option('devtools',{
      description: 'Run the task with devtools open. Often used with --no-autoclose option. Use --no- prefix to negate.',
      global: false,
      type: 'boolean',
    })
    yargs.option('autoclose',{
      description: 'Close the browser after each task. Use --no- prefix to negate.',
      global: false,
      type: 'boolean'
    })
    yargs.positional('tasks', {
      type: 'string',
      describe: 'A list of tasks or named task groups',
    })
  },
  async argv => {
    argv.tasks = argv.tasks || []
    parseTaskFiles()
    let tasksToRun = normalizeTaskSet(argv.tasks)

    let profilesToRun = argv.profiles ? argv.profiles : []
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
      if (typeof argv.screenshot !== 'undefined') {
        config.profiles[p].screenshot = argv.screenshot
      }
      if (typeof argv.autoclose !== 'undefined') {
        config.profiles[p].autoclose = argv.autoclose
      }
      if (typeof argv.devtools !== 'undefined') {
        config.profiles[p].devtools = argv.devtools
      }
    })

    pwp.run(tasksToRun, profilesToRun, config)

  }
)

yargs.command(
  ['clear-cookies'],
  'Remove cookies for the specified profiles',
  addProfilesOpt,
  async argv => {
    if (!argv.profiles) {
      yargs.showHelp()
      // invoked by command handler so must explicitly invoke console
      console.error(errorTxt(`The "${argv._[0]}" command requires 1 or more profiles.`))
      process.exit(1)
    }
    for (let p in argv.profiles) {
      const rl = readline.createInterface({input: process.stdin, output: process.stdout})
      const it = rl[Symbol.asyncIterator]()
      console.log(`Clear cookies for profile "${p}"\n(y/n): `)
      const answer = await it.next()
      rl.close()
      if (answer.value === 'y') {
        pwp.clearCookiesByProfile(p)
      }
    }
  }
)

yargs
  .usage(cmdTxt('$0 <cmd> [args]'))
  .wrap(yargs.terminalWidth())
  .strict()
  .updateStrings({
    'Commands:': headerTxt('Commands:'),
    'Options:': headerTxt('Options:     ** Commands may have additional options. See <cmd> -h. **'),
    'Positionals:': headerTxt('Positionals:'),
    'Not enough non-option arguments: got %s, need at least %s': errorTxt(
      'Not enough non-option arguments: got %s, need at least %s'
    )
  })
  .alias('h', 'help')
  .check(arg => {
    if (!arg._.length) {
      yargs.showHelp()
    }
    return true
  }, true)
  .version(false)

;(async () => {
  yargs.argv
})()