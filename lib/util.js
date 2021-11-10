const fs = require('fs'),
  path = require('path')

const copyDirSync = exports.copyDirSync = function (src, dst) {
  const exists = fs.existsSync(src),
    stats = exists && fs.statSync(src),
    isDir = exists && stats.isDirectory()
  if (isDir) {
    fs.mkdirSync(dst)
    fs.readdirSync(src).forEach(function (child) {
      copyDirSync(path.join(src, child), path.join(dst, child))
    })
  } else {
    fs.copyFileSync(src, dst)
  }
}