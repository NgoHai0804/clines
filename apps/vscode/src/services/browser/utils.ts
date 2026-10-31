import { fileExistsAtPath } from "@utils/fs"
import * as fs from "fs/promises"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { loadLazyChunk } from "@/utils/load-lazy-chunk"
import type * as LazyBrowser from "./lazy-browser"

interface PCRStats {
	puppeteer: { launch: typeof import("puppeteer-core").launch }
	executablePath: string
}

function getLazyBrowser(): typeof LazyBrowser {
	return loadLazyChunk<typeof LazyBrowser>("browser")
}

export async function ensureChromiumExists(): Promise<PCRStats> {
	const puppeteerDir = path.join(HostProvider.get().globalStorageFsPath, "puppeteer")
	const dirExists = await fileExistsAtPath(puppeteerDir)
	if (!dirExists) {
		await fs.mkdir(puppeteerDir, { recursive: true })
	}
	// if chromium doesn't exist, this will download it to path.join(puppeteerDir, ".chromium-browser-snapshots")
	// if it does exist it will return the path to existing chromium
	const stats: PCRStats = await getLazyBrowser().resolveChromium(puppeteerDir)
	return stats
}
