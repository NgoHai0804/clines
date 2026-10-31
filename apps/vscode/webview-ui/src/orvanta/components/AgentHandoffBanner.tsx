import { IconCheck, IconFileCheck, IconSend } from "@tabler/icons-react"
import { memo } from "react"
import { AgentBadge } from "@/components/common/AgentBadge"

export interface AgentHandoffBannerProps {
	recipientId?: string
	recipientDisplayName?: string
	summary?: string
	artifactPath?: string
	completedAt?: string
}

export const AgentHandoffBanner = memo(
	({ recipientId = "coordinator", recipientDisplayName = "Coordinator", summary, artifactPath }: AgentHandoffBannerProps) => {
		return (
			<div className="mx-3 my-3 rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-3 text-xs shadow-sm">
				<div className="flex items-center justify-between gap-2">
					<div className="flex items-center gap-2 min-w-0">
						<div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
							<IconSend className="h-3.5 w-3.5" />
						</div>
						<div className="flex items-center gap-1.5 flex-wrap min-w-0">
							<span className="font-semibold text-emerald-300">Đã hoàn thành task — chuyển tới:</span>
							<AgentBadge agentId={recipientId} agentRole="lead" displayName={recipientDisplayName} size="sm" />
						</div>
					</div>

					<span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-medium text-emerald-400 shrink-0">
						<IconCheck className="h-3 w-3 stroke-[2.5]" />
						Đã hoàn thành
					</span>
				</div>

				{summary && (
					<div className="mt-2 text-[11px] text-slate-300 bg-slate-900/60 rounded border border-emerald-500/20 p-2">
						{summary}
					</div>
				)}

				{artifactPath && (
					<div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-400">
						<IconFileCheck className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
						<span className="truncate">
							Sản phẩm bàn giao: <code className="text-slate-300">{artifactPath}</code>
						</span>
					</div>
				)}
			</div>
		)
	},
)

AgentHandoffBanner.displayName = "AgentHandoffBanner"
