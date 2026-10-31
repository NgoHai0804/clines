import type { EmptyRequest } from "@shared/proto/cline/common"
import { StringRequest } from "@shared/proto/cline/common"
import type { OrvantaAgentProfile, OrvantaCompanyResponse } from "@shared/proto/cline/orvanta"
import { useCallback, useEffect, useState } from "react"
import { OrvantaServiceClient } from "@/services/grpc-client"

const emptyRequest = {} as EmptyRequest

const emptyCompany: OrvantaCompanyResponse = {
	status: "missing",
	errors: [],
	id: "",
	name: "",
	purpose: "",
	teamName: "",
	agents: [],
	tasksJson: "",
}

function profilesToMap(profiles: OrvantaAgentProfile[]): Record<string, OrvantaAgentProfile> {
	const map: Record<string, OrvantaAgentProfile> = {}
	for (const profile of profiles) {
		if (profile?.id) {
			map[profile.id] = profile
		}
	}
	return map
}

export function useOrvantaCompany() {
	const [company, setCompany] = useState<OrvantaCompanyResponse>(emptyCompany)
	const [agentProfiles, setAgentProfiles] = useState<Record<string, OrvantaAgentProfile>>({})
	const [loading, setLoading] = useState(true)
	const [creating, setCreating] = useState(false)
	const [createError, setCreateError] = useState<string | undefined>()

	const refreshAgentProfiles = useCallback(async () => {
		try {
			const resp = await OrvantaServiceClient.listAgentProfiles(emptyRequest)
			setAgentProfiles(profilesToMap(resp?.profiles ?? []))
		} catch (err) {
			console.error("orvanta.listAgentProfiles", err)
		}
	}, [])

	const refresh = useCallback(async () => {
		try {
			const resp = await OrvantaServiceClient.getCompany(emptyRequest)
			if (resp) {
				setCompany(resp)
				if (resp.status === "ready") {
					await refreshAgentProfiles()
				} else {
					setAgentProfiles({})
				}
			}
		} catch (err) {
			console.error("orvanta.refresh", err)
		}
	}, [refreshAgentProfiles])

	useEffect(() => {
		let cancelled = false
		let settled = false

		const finishLoading = () => {
			if (!cancelled && !settled) {
				settled = true
				setLoading(false)
			}
		}

		// If the extension host is mid-rebuild (missing @generated / gRPC dead),
		// getCompany may never resolve — don't leave Home stuck on "loading".
		const hangTimeout = window.setTimeout(() => {
			if (cancelled || settled) return
			console.error("orvanta.getCompany timed out")
			setCompany((prev) =>
				prev.status === "missing" && (prev.errors?.length ?? 0) === 0
					? {
							...emptyCompany,
							status: "broken",
							errors: [
								"Không tải được công ty (timeout). Thử xóa file .orvanta/org/roster.json.lock nếu còn, rồi Reload Extension Development Host.",
							],
						}
					: prev,
			)
			finishLoading()
		}, 20_000)

		OrvantaServiceClient.getCompany(emptyRequest)
			.then(async (resp) => {
				if (cancelled || !resp) return
				setCompany(resp)
				if (resp.status === "ready") {
					try {
						const profilesResp = await OrvantaServiceClient.listAgentProfiles(emptyRequest)
						if (!cancelled) {
							setAgentProfiles(profilesToMap(profilesResp?.profiles ?? []))
						}
					} catch (err) {
						console.error("orvanta.listAgentProfiles", err)
					}
				}
				finishLoading()
			})
			.catch((err) => {
				console.error("orvanta.getCompany", err)
				if (!cancelled) {
					const message = err instanceof Error ? err.message : String(err)
					setCompany({
						...emptyCompany,
						status: "broken",
						errors: [message || "Không tải được công ty"],
					})
					setAgentProfiles({})
					finishLoading()
				}
			})

		const unsubscribe = OrvantaServiceClient.subscribeCompany(emptyRequest, {
			onResponse: (response) => {
				if (cancelled) return
				setCompany(response)
				finishLoading()
				if (response.status === "ready") {
					void OrvantaServiceClient.listAgentProfiles(emptyRequest)
						.then((profilesResp) => {
							if (!cancelled) {
								setAgentProfiles(profilesToMap(profilesResp?.profiles ?? []))
							}
						})
						.catch((err) => console.error("orvanta.listAgentProfiles", err))
				} else {
					setAgentProfiles({})
				}
			},
			onError: (error) => {
				console.error("orvanta.subscribeCompany", error)
				finishLoading()
			},
			onComplete: () => {
				finishLoading()
			},
		})

		return () => {
			cancelled = true
			window.clearTimeout(hangTimeout)
			unsubscribe()
		}
	}, [])

	// Fallback poll (1s) when any agent is running to ensure UI never gets stuck
	// biome-ignore lint/correctness/useExhaustiveDependencies: polling fallback
	useEffect(() => {
		const hasRunning = (company.agents ?? []).some((a) => a.status === "running")
		if (!hasRunning) return
		const interval = setInterval(() => {
			void refresh()
		}, 1000)
		return () => clearInterval(interval)
	}, [company.agents, refresh])

	const createCompany = async (name: string, purpose: string) => {
		setCreating(true)
		setCreateError(undefined)
		try {
			const response = await OrvantaServiceClient.createCompany({
				name: name.trim(),
				purpose: purpose.trim(),
			})
			if (response.status === "ready") {
				setCompany(response)
				await refreshAgentProfiles()
			} else {
				setCreateError(response.errors[0] ?? "Không lập được công ty")
			}
			return response
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			setCreateError(message)
			return undefined
		} finally {
			setCreating(false)
		}
	}

	const saveAgentProfile = async (profile: OrvantaAgentProfile): Promise<boolean> => {
		try {
			const saved = await OrvantaServiceClient.upsertAgentProfile(profile)
			setAgentProfiles((prev) => ({
				...prev,
				[saved.id]: saved,
			}))
			await refresh()
			return true
		} catch (err) {
			console.error("orvanta.saveAgentProfile error", err)
			return false
		}
	}

	const deleteAgentProfile = async (agentId: string): Promise<boolean> => {
		try {
			await OrvantaServiceClient.deleteAgentProfile(StringRequest.create({ value: agentId }))
			setAgentProfiles((prev) => {
				const next = { ...prev }
				delete next[agentId]
				return next
			})
			await refresh()
			return true
		} catch (err) {
			console.error("orvanta.deleteAgentProfile error", err)
			return false
		}
	}

	return {
		company,
		agentProfiles,
		loading,
		creating,
		createError,
		createCompany,
		refresh,
		saveAgentProfile,
		deleteAgentProfile,
	}
}
