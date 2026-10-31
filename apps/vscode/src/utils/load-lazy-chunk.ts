import fs from "node:fs"
import path from "node:path"

const cache = new Map<string, unknown>()

/**
 * Load a secondary esbuild chunk from `dist/lazy/<name>.js`.
 * Dynamic require keeps these out of the cold-start parse of `extension.js`.
 */
export function loadLazyChunk<T>(chunkName: string): T {
	const cached = cache.get(chunkName)
	if (cached) {
		return cached as T
	}

	const candidates = [
		// Bundled extension: this helper lives inside dist/extension.js → __dirname is dist/
		path.join(__dirname, "lazy", `${chunkName}.js`),
		// Vitest / unbundled source: this file is under src/utils → apps/vscode/dist/lazy
		path.join(__dirname, "..", "..", "dist", "lazy", `${chunkName}.js`),
	]

	let lastError: unknown
	for (const chunkPath of candidates) {
		try {
			if (!fs.existsSync(chunkPath)) {
				continue
			}
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const mod = require(chunkPath) as T
			cache.set(chunkName, mod)
			return mod
		} catch (error) {
			lastError = error
		}
	}

	throw new Error(
		`Failed to load lazy chunk "${chunkName}". Tried: ${candidates.join(", ")}. ${
			lastError instanceof Error ? lastError.message : String(lastError ?? "not found")
		}`,
	)
}
