import { fireEvent, render, screen } from "@testing-library/react"
import type { ButtonHTMLAttributes, PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ContextUsageRing from "./ContextUsageRing"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) => (
		<button {...props}>{children}</button>
	),
}))

vi.mock("@/components/ui/popover", () => ({
	Popover: ({ children, open }: PropsWithChildren<{ open?: boolean; onOpenChange?: (open: boolean) => void }>) => (
		<div data-open={open}>{children}</div>
	),
	PopoverContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
	PopoverTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
}))

vi.mock("@/components/ui/progress", () => ({
	Progress: ({ value }: { value?: number }) => (
		<div aria-label="Context window usage progress" role="progressbar">
			{value}
		</div>
	),
}))

vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: ({ children }: PropsWithChildren) => <>{children}</>,
	TooltipContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
	TooltipTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
}))

vi.mock("@/components/ui/button", () => ({
	Button: ({ children, ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) => (
		<button {...props}>{children}</button>
	),
}))

describe("ContextUsageRing compact button", () => {
	beforeEach(() => vi.clearAllMocks())

	it("runs the shared compact handler after confirmation instead of sending /compact as a message", () => {
		const compactTask = vi.fn().mockResolvedValue(true)

		render(
			<ContextUsageRing
				compactDisabled={false}
				compactTask={compactTask}
				contextWindow={200_000}
				lastApiReqTotalTokens={120_000}
				tokensIn={80_000}
				tokensOut={40_000}
			/>,
		)

		fireEvent.click(screen.getByTestId("context-usage-ring"))
		fireEvent.click(screen.getByRole("button", { name: /compact task/i }))
		fireEvent.click(screen.getByRole("button", { name: /^compact$/i }))

		expect(compactTask).toHaveBeenCalledTimes(1)
	})

	it("disables compaction during API error recovery", () => {
		render(
			<ContextUsageRing
				compactDisabled={true}
				compactTask={vi.fn()}
				contextWindow={200_000}
				lastApiReqTotalTokens={120_000}
			/>,
		)

		fireEvent.click(screen.getByTestId("context-usage-ring"))
		expect(screen.getByRole("button", { name: /compact task/i })).toBeDisabled()
	})

	it("hides when context window is unavailable", () => {
		const { container } = render(
			<ContextUsageRing compactDisabled={false} compactTask={vi.fn()} lastApiReqTotalTokens={120_000} />,
		)
		expect(container).toBeEmptyDOMElement()
	})
})
