import type { Meta, StoryObj } from "@storybook/react-vite"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import ContextUsageRing from "./ContextUsageRing"

const meta: Meta<typeof ContextUsageRing> = {
	title: "Views/Components/ContextUsageRing",
	component: ContextUsageRing,
	parameters: {
		layout: "padded",
		docs: {
			description: {
				component:
					"Circular context-usage indicator for the chat input. Click opens a popover with token breakdown and Compact Task.",
			},
		},
	},
	decorators: [createStorybookDecorator()],
	argTypes: {
		contextWindow: { control: "number", description: "Model context window size" },
		lastApiReqTotalTokens: { control: "number", description: "Tokens used by the last request" },
	},
}

export default meta
type Story = StoryObj<typeof ContextUsageRing>

export const HighUsage: Story = {
	args: {
		contextWindow: 200_000,
		lastApiReqTotalTokens: 146_000,
		tokensIn: 45_000,
		tokensOut: 28_000,
		cacheWrites: 5_200,
		cacheReads: 3_800,
		compactDisabled: false,
		compactTask: async () => true,
	},
	parameters: {
		docs: {
			description: {
				story: "High context usage. Click the ring, then the fold icon, to open the compact-task confirmation card.",
			},
		},
	},
}
