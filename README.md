# Puppeteer With Profiles

Puppeteer with profiles (`pwp`) greatly simplifies running 1 or more "tasks" using predefined Chrome profiles and records the output to the specified directory. `pwp` is particularly useful for testing applications that use Chrome extensions.

A task is just a sequence of puppeteer [page cmds](https://github.com/puppeteer/puppeteer/blob/v11.0.0/docs/api.md#class-page). `pwp` handles all the browser & profile management as well as logging the results.

Once you've created your `.pwp.json` config file and added some tasks to your tasks folder, you're ready to go. By grouping tasks, you can launch a series of tasks with a single name.

# Installation

## Add `pwp` to existing node projects

 Just run the typical node cmd: `npm install pwp@latest --save`. Then add your configuration and you're good to go.

## Use `pwp` for web tasks

Install pwp globally: `npm install -g pwp`

Then create a pwp project in a folder of your choice: `pwp --new-project` This will create the default files for you. Just add some tasks and you're ready to run.