import { Resource, tables } from 'harperdb'

export class ImportStatus extends Resource {
	static loadAsInstance = false

	async get(target) {
		target.checkPermission = false
		let total = 0
		try {
			for await (const _ of tables.Celebrity.search({})) total++
		} catch { /* table not yet present */ }

		let lastFinished = null
		let lastImported = 0
		let lastErrors = 0
		try {
			for await (const r of tables.ImportLog.search({})) {
				if (r.finishedAt && (!lastFinished || r.finishedAt > lastFinished)) {
					lastFinished = r.finishedAt
					lastImported = r.totalImported ?? 0
					lastErrors = (r.errors?.length) ?? 0
				}
			}
		} catch { /* ignore */ }

		return {
			indexed: total,
			lastFinishedAt: lastFinished,
			lastBatchImported: lastImported,
			lastBatchErrorCount: lastErrors,
		}
	}
}
