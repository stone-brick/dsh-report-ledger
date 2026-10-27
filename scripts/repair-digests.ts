// A module, not a global script: without an import/export this file shares the
// global scope with its siblings, so top-level names collide across scripts and
// `filter` silently resolves to the DOM's window.filter. This file is emitted as
// nothing; the export exists so `tsc` treats it as its own module.
export {}
/**
 * Bring every digest in the ledger back in line with its hop stream.
 *
 * Front matter is a cache of the transfer path, so it is only as current as a
 * report's last mutation. That is invisible while the projection's meaning never
 * changes — and it stops being invisible the moment a derived field is added: a
 * document written before `reads` existed reports zero reads until something else
 * touches it, which reads as "nobody ever opened this" rather than "this document
 * predates the field". This is that something.
 *
 * A script rather than a model tool, deliberately. It rewrites every report in the
 * ledger — the one operation whose blast radius is the whole collaboration — so
 * running it belongs to the human who knows whether the ledger is being written to
 * right now. Reports are still repaired one writer lock at a time, so a concurrent
 * turn is not corrupted, only interleaved with.
 *
 * It is also the migration switch for a future change of the projection's
 * DEFINITION (not just an addition): run it once so every digest agrees with the
 * old rule, ship the new rule, run it again. The alternative — letting each report
 * pick up the new meaning whenever it next happens to be mutated — would leave two
 * meanings in one ledger with no field saying which is which.
 *
 * Run: node scripts/repair-digests.ts [--dry-run]
 */

const { ReportService } = await import('../src/report/service.ts')
const { ledgerRoot } = await import('../src/report/ledger.ts')

const dryRun = process.argv.includes('--dry-run')
// Repair reads the ledger and nothing else: no delivery, no titles, no agent
// lookup. The constructor requires a host, so it gets the smallest thing that
// satisfies it rather than a fake that pretends to do work.
const service = new ReportService({
  getAgent: () => undefined,
  describe: async () => undefined,
})

const repairs = await service.repairDigests({ dryRun })
const stale = repairs.filter((repair) => repair.changed)
const unpatchable = stale.filter((repair) => repair.skipped !== undefined)

console.log(`ledger: ${ledgerRoot()}`)
console.log(
  `${repairs.length} report(s); ${stale.length} digest(s) disagreed with their transfer path`
  + (dryRun ? ' (dry run — nothing written)' : ''),
)
for (const repair of stale) {
  console.log(`  ${repair.report}  ${repair.stored}  ->  ${repair.derived}`)
  if (repair.skipped !== undefined) console.log(`    left alone: ${repair.skipped}`)
}
if (!dryRun && stale.length > unpatchable.length) {
  console.log(`\nrewrote ${stale.length - unpatchable.length} digest(s).`)
}
if (unpatchable.length > 0) {
  console.log(
    `\n${unpatchable.length} report(s) could not be repaired: their transfer path is damaged or gone. `
    + 'Restore the .route.jsonl file before rebuilding their digest, or the recipients recorded in it would be lost.',
  )
}
process.exit(0)
