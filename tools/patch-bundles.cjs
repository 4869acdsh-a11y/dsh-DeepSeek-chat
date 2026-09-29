/**
 * 安全地增删 profile package.json 里 dsh.profile.bundles 的一项。
 *
 * 单独放一个文件，而不是塞进 install.ps1 的 here-string：
 * PowerShell 5.1 对 .ps1 的编码很挑（无 BOM 的 UTF-8 会被当成 GBK 读，
 * 中文会把解析器搞崩），把 JS 拆出来可以彻底绕开这个坑。
 *
 * 用法：
 *   node patch-bundles.cjs add    <profile package.json> <包名>
 *   node patch-bundles.cjs remove <profile package.json> <包名>
 *
 * 输出（第一行是结论，第二行是最终数组）：
 *   ADDED | ALREADY | REMOVED | NOT_PRESENT | NO_BUNDLES
 */
const fs = require('node:fs')

const [, , action, pkgPath, name] = process.argv

if (!action || !pkgPath || !name) {
  console.error('usage: patch-bundles.cjs <add|remove> <package.json> <name>')
  process.exit(2)
}

const raw = fs.readFileSync(pkgPath, 'utf8')
const doc = JSON.parse(raw)

if (!doc.dsh) doc.dsh = {}
if (!doc.dsh.profile) doc.dsh.profile = {}
if (!Array.isArray(doc.dsh.profile.bundles)) doc.dsh.profile.bundles = []

const bundles = doc.dsh.profile.bundles
let verdict

if (action === 'add') {
  if (bundles.includes(name)) {
    verdict = 'ALREADY'
  } else {
    bundles.push(name)
    verdict = 'ADDED'
  }
} else if (action === 'remove') {
  const i = bundles.indexOf(name)
  if (i >= 0) {
    bundles.splice(i, 1)
    verdict = 'REMOVED'
  } else {
    verdict = 'NOT_PRESENT'
  }
} else {
  console.error('unknown action: ' + action)
  process.exit(2)
}

fs.writeFileSync(pkgPath, JSON.stringify(doc, null, 2) + '\n', 'utf8')
console.log(verdict)
console.log(JSON.stringify(bundles))
