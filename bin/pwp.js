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
  errorTxt = txt => chalk.bold.white.bgRed(txt),
  warningTxt = headerTxt = txt => chalk.yellow(txt),
  successTxt = cmdTxt = txt => chalk.green(txt),
  fadeTxt = txt => chalk.grey(txt)

let pwp
if (/node_modules/.test(__dirname)) {
  pwp = require('pwp') // when used as module in another project
} else {
  pwp = require('../lib/index') // when actively developing or debugging this module itself
}

const addProfilesOpt = function (yargs) {
  // remove the special blank profile
  const profiles = Object.keys(pwp.getValidatedConfig().profiles).filter(x => x !== 'PWP_BLANK_PROFILE')
  yargs.option('p', {
    alias: 'profiles',
    description: 'list of profiles',
    type: 'string',
    choices: profiles,
    // yargs returns a single "choice" as a string but multiple choices as an array. make it consistent.
    coerce: x => typeof x === 'string' ? [x] : x
  })
  yargs.option('all-profiles', {
    description: 'Applies to all profiles in config file',
    type: 'boolean',
    conflicts: 'profiles'
  })
}

yargs.command('new-project',
  'Create a new pwp project with sample config in the current directory',
  () => {},
  argv => {
    try {
      const result = pwp.createProject()
      console.log(successTxt(result.message))
    } catch (error) {
      console.error(errorTxt(error.message))
      process.exit(1)
    }
  }
)

yargs.command('list',
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
      console.error(errorTxt(error.message))
      process.exit(1)
    }
  }
)

// yargs positionals args using the [...] syntax will return all remaining args in an array or an empty array
yargs.command('run [tasks...]',
  'Run a list of tasks with the specified options',
  yargs => {
    addProfilesOpt(yargs)
    yargs.option('screenshot', {
      description: 'Screenshot the page after each task is run. Use --no- prefix to negate.',
      global: false,
      type: 'boolean'
    })
    yargs.option('devtools', {
      description: 'Run the task with devtools open. Often used with --no-autoclose option. Use --no- prefix to negate.',
      global: false,
      type: 'boolean',
    })
    yargs.option('autoclose', {
      description: 'Close the browser after each task. Use --no- prefix to negate.',
      global: false,
      type: 'boolean'
    })
    yargs.option('u', {
      alias: 'url',
      description: 'A url to substitute in tasks when the "{url}" is specified',
      type: 'string'
    })
    yargs.option('max', {
      description: 'The maximum number of chrome browsers to run at the same time',
      type: 'number',
      default: 2
    })
    yargs.option('all-tasks', {
      description: 'Run all tasks',
      type: 'boolean',
      conflicts: 'tasks'
    })
    yargs.option('blank-profile', {
      description: 'Use a blank profile (no prev history, cookies, exts, etc.)',
      type: 'boolean'
    })
    yargs.positional('tasks', {
      type: 'string',
      describe: 'A list of tasks or named task groups',
    })
    yargs.example([
      ['$0 -p dev google-login', 'Use the "dev" profile to run the "google-login" task'],
      ['$0 --no-screenshot store-checkout', 'Run the "store-checkout" task with default profiles. Override any screenshot option.'],
      ['$0 --all-tasks --all-profiles --max 2', 'Run all tasks with all profiles using 2 concurrent browsers max']
    ])
  },
  async argv => {
    try {
      if (!argv.tasks.length) {
        yargs.showHelp()
        throw {message: 'At least 1 task must be provided.'}
      }
      const profilesToRun = argv.profiles || [] // if no profiles provided, pass an empty array
      if (argv['blank-profile']) {
        profilesToRun.push('PWP_BLANK_PROFILE')
      }
      pwp.runTasks(argv.tasks, profilesToRun, argv.max, argv.url, {
        screenshot: argv.screenshot,
        autoclose: argv.autoclose,
        devtools: argv.devtools
      })
    } catch (error) {
      console.error(errorTxt(error.message))
      process.exit(1)
    }
  }
)

yargs.command('clear-cookies',
  'Remove cookies for the specified profiles',
  addProfilesOpt,
  async argv => {
    try {
      if (!argv.profiles) {
        yargs.showHelp()
        // invoked by command handler so must explicitly invoke console
        throw {message: `The "${argv._[0]}" command requires 1 or more profiles.`}
      }
      for (let i in argv.profiles) {
        let p = argv.profiles[i]
        const rl = readline.createInterface({input: process.stdin, output: process.stdout})
        const it = rl[Symbol.asyncIterator]()
        console.log(`Clear cookies for profile "${p}"\n(y/n): `)
        const answer = await it.next()
        rl.close()
        if (answer.value === 'y') {
          pwp.clearCookiesByProfile(p)
        }
      }
    } catch (error) {
      console.error(errorTxt(error.message))
      process.exit(1)
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
    'Examples:': headerTxt('Examples:'),
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