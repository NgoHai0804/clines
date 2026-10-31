import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import React, { memo, useCallback, useMemo, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import { formatLargeNumber as formatTokenNumber } from "@/utils/format"
import CompactTaskButton from "./buttons/CompactTaskButton"

export interface ContextUsageRingProps {
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
	cacheReads?: number
	lastApiReqTotalTokens?: number
	contextWindow?: number
	compactDisabled: boolean
	compactTask: () => Promise<boolean>
}

const RING_SIZE = 16
const RING_STROKE = 2
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

const ConfirmationDialog = memo<{
	onConfirm: (e: React.MouseEvent) => void
	onCancel: (e: React.MouseEvent) => void
}>(({ onConfirm, onCancel }) => (
	<div className="mt-2 flex flex-col gap-2 rounded-sm border border-border-panel bg-code p-2 text-sm">
		<span className="font-semibold">Compact the current task?</span>
		<span className="text-xs text-description">
			Replaces the conversation history with a summary to free up context window space.
		</span>
		<span className="flex justify-end gap-1.5">
			<VSCodeButton
				appearance="secondary"
				className="text-sm"
				onClick={onCancel}
				title="No, keep the task as is"
				type="button">
				Cancel
			</VSCodeButton>
			<VSCodeButton
				appearance="primary"
				autoFocus={true}
				className="text-sm"
				onClick={onConfirm}
				title="Yes, compact the task"
				type="button">
				Compact
			</VSCodeButton>
		</span>
	</div>
))
ConfirmationDialog.displayName = "ConfirmationDialog"

const TOKEN_ROWS: { title: string; key: "tokensIn" | "tokensOut" | "cacheWrites" | "cacheReads"; swatch: string }[] = [
	{ title: "Prompt Tokens", key: "tokensIn", swatch: "var(--vscode-charts-blue)" },
	{ title: "Completion Tokens", key: "tokensOut", swatch: "var(--vscode-charts-green)" },
	{ title: "Cache Writes", key: "cacheWrites", swatch: "var(--vscode-charts-orange)" },
	{ title: "Cache Reads", key: "cacheReads", swatch: "var(--vscode-charts-purple)" },
]

const ContextUsageRing: React.FC<ContextUsageRingProps> = ({
	contextWindow = 0,
	compactDisabled,
	compactTask,
	lastApiReqTotalTokens = 0,
	tokensIn,
	tokensOut,
	cacheWrites,
	cacheReads,
}) => {
	const [open, setOpen] = useState(false)
	const [confirmationNeeded, setConfirmationNeeded] = useState(false)

	const tokenData = useMemo(() => {
		if (!contextWindow) {
			return null
		}
		return {
			percentage: Math.min(100, (lastApiReqTotalTokens / contextWindow) * 100),
			max: contextWindow,
			used: lastApiReqTotalTokens,
		}
	}, [contextWindow, lastApiReqTotalTokens])

	const values = useMemo(
		() => ({
			tokensIn,
			tokensOut,
			cacheWrites: cacheWrites || 0,
			cacheReads: cacheReads || 0,
		}),
		[tokensIn, tokensOut, cacheWrites, cacheReads],
	)

	const handleCompactClick = useCallback((e: React.MouseEvent) => {
		e.preventDefault()
		e.stopPropagation()
		setConfirmationNeeded((prev) => !prev)
	}, [])

	const handleConfirm = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault()
			e.stopPropagation()
			void compactTask().catch((err) => console.error("Failed to compact task:", err))
			setConfirmationNeeded(false)
		},
		[compactTask],
	)

	const handleCancel = useCallback((e: React.MouseEvent) => {
		e.preventDefault()
		e.stopPropagation()
		setConfirmationNeeded(false)
	}, [])

	const handleOpenChange = useCallback((next: boolean) => {
		setOpen(next)
		if (!next) {
			setConfirmationNeeded(false)
		}
	}, [])

	if (!tokenData) {
		return null
	}

	const dashOffset = RING_CIRCUMFERENCE * (1 - tokenData.percentage / 100)
	const percentLabel = `${tokenData.percentage.toFixed(0)}% Full`

	return (
		<Popover onOpenChange={handleOpenChange} open={open}>
			<PopoverTrigger asChild>
				<button
					aria-label={`Context usage ${percentLabel}`}
					className="flex items-center justify-center h-7 w-7 rounded-md text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground) hover:bg-white/10 transition-colors cursor-pointer bg-transparent border-0 p-0"
					data-testid="context-usage-ring"
					title={`Context ${percentLabel}`}
					type="button">
					<svg
						aria-hidden="true"
						className="shrink-0"
						height={RING_SIZE}
						viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
						width={RING_SIZE}>
						<circle
							cx={RING_SIZE / 2}
							cy={RING_SIZE / 2}
							fill="none"
							r={RING_RADIUS}
							stroke="var(--vscode-editorWidget-border)"
							strokeWidth={RING_STROKE}
						/>
						<circle
							cx={RING_SIZE / 2}
							cy={RING_SIZE / 2}
							fill="none"
							r={RING_RADIUS}
							stroke="var(--vscode-foreground)"
							strokeDasharray={RING_CIRCUMFERENCE}
							strokeDashoffset={dashOffset}
							strokeLinecap="round"
							strokeWidth={RING_STROKE}
							transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
						/>
					</svg>
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className="context-window-tooltip-content w-72 p-3"
				data-testid="context-usage-popover"
				side="top"
				sideOffset={8}>
				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between gap-2">
						<span className="text-sm font-semibold text-foreground">Context Usage</span>
						<CompactTaskButton disabled={compactDisabled} onClick={handleCompactClick} />
					</div>

					<div className="flex items-center justify-between text-xs text-description">
						<span>{percentLabel}</span>
						<span>
							~{formatTokenNumber(tokenData.used)} / {formatTokenNumber(tokenData.max)} Tokens
						</span>
					</div>

					<Progress aria-label="Context window usage progress" value={tokenData.percentage} />

					<div className="flex flex-col gap-1 mt-1">
						{TOKEN_ROWS.map((row) => {
							const value = values[row.key]
							if (!value) {
								return null
							}
							return (
								<div className="flex items-center justify-between gap-2 text-xs" key={row.key}>
									<span className="flex items-center gap-1.5 min-w-0">
										<span
											aria-hidden="true"
											className="inline-block size-2.5 rounded-[2px] shrink-0"
											style={{ backgroundColor: row.swatch }}
										/>
										<span className="truncate">{row.title}</span>
									</span>
									<span className="font-mono text-muted-foreground shrink-0">{formatTokenNumber(value)}</span>
								</div>
							)
						})}
					</div>

					{confirmationNeeded && <ConfirmationDialog onCancel={handleCancel} onConfirm={handleConfirm} />}
				</div>
			</PopoverContent>
		</Popover>
	)
}

export default memo(ContextUsageRing)
