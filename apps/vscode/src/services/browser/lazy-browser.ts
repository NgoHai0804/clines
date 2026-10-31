// @ts-expect-error — puppeteer-chromium-resolver has no types
import PCR from "puppeteer-chromium-resolver"
import type { ConsoleMessage, ScreenshotOptions } from "puppeteer-core"
import { Browser, connect, launch, Page, TimeoutError } from "puppeteer-core"

export { Browser, connect, launch, Page, TimeoutError, PCR }
export type { ConsoleMessage, ScreenshotOptions }

export async function resolveChromium(downloadPath: string) {
	return PCR({
		downloadPath,
	})
}
