import { ClineMessage } from "@shared/ExtensionMessage"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import { Environment } from "../../../../../src/config"
import TaskHeader from "./TaskHeader"

const meta: Meta<typeof TaskHeader> = {
	title: "Views/Components/TaskHeader",
	component: TaskHeader,
	parameters: {
		layout: "padded",
		docs: {
			description: {
				component:
					"TaskHeader displays task information, cost, and provides controls for task management. Context usage lives in the chat input ring.",
			},
		},
	},
	decorators: [createStorybookDecorator()],
	argTypes: {
		totalCost: { control: "number", description: "Total cost in USD" },
	},
}

export default meta
type Story = StoryObj<typeof TaskHeader>

const createTask = (text: string, images?: string[], files?: string[]): ClineMessage => ({
	ts: Date.now(),
	type: "say",
	say: "task",
	text,
	images,
	files,
})

const createMessages = (): ClineMessage[] => [
	{
		ts: Date.now() - 300000,
		type: "say",
		say: "task",
		text: "Create a React component",
	},
	{
		ts: Date.now() - 240000,
		type: "say",
		say: "text",
		text: "I'll help you create a React component.",
	},
	{
		ts: Date.now() - 180000,
		type: "say",
		say: "tool",
		text: JSON.stringify({ tool: "write_to_file", path: "Component.tsx" }),
	},
	{
		ts: Date.now() - 120000,
		type: "say",
		say: "text",
		text: "Component created successfully.",
	},
]

const anthropicConfig = {
	actModeApiProvider: "anthropic" as const,
	actModeApiModelId: "claude-3-5-sonnet-20241022",
}

export const Collapsed: Story = {
	args: {
		task: createTask("Create a responsive navigation component for a React application"),
		totalCost: 0.085,
		onClose: () => console.log("Close clicked"),
	},
	decorators: [
		createStorybookDecorator({
			expandTaskHeader: false,
			apiConfiguration: anthropicConfig,
			clineMessages: createMessages(),
		}),
	],
}

export const Expanded: Story = {
	args: {
		task: createTask("Create a responsive navigation component for a React application"),
		totalCost: 0.085,
		onClose: () => console.log("Close clicked"),
	},
	decorators: [
		createStorybookDecorator({
			expandTaskHeader: true,
			apiConfiguration: anthropicConfig,
			clineMessages: createMessages(),
		}),
	],
}

export const WithImages: Story = {
	args: {
		task: createTask(
			"Analyze these screenshots and identify UI issues",
			["https://via.placeholder.com/400x300?text=Screenshot1", "https://via.placeholder.com/400x300?text=Screenshot2"],
			undefined,
		),
		totalCost: 0.125,
		onClose: () => console.log("Close clicked"),
	},
	decorators: [
		createStorybookDecorator({
			expandTaskHeader: true,
			apiConfiguration: anthropicConfig,
			clineMessages: createMessages(),
		}),
	],
}

export const WithFiles: Story = {
	args: {
		task: createTask("Review these configuration files and suggest improvements", undefined, [
			"package.json",
			"tsconfig.json",
			"vite.config.ts",
		]),
		totalCost: 0.185,
		onClose: () => console.log("Close clicked"),
	},
	decorators: [
		createStorybookDecorator({
			expandTaskHeader: true,
			apiConfiguration: anthropicConfig,
			clineMessages: createMessages(),
		}),
	],
}

export const LongTaskText: Story = {
	args: {
		task: createTask(
			"Create a comprehensive e-commerce application with the following features:\n1. User authentication and authorization\n2. Product catalog with search and filtering\n3. Shopping cart functionality\n4. Checkout process with payment integration\n5. Order management system",
		),
		totalCost: 0.245,
		onClose: () => console.log("Close clicked"),
	},
	decorators: [
		createStorybookDecorator({
			expandTaskHeader: true,
			apiConfiguration: anthropicConfig,
			clineMessages: createMessages(),
		}),
	],
}

export const NoCost: Story = {
	args: {
		task: createTask("Test local model with Ollama"),
		totalCost: 0,
		onClose: () => console.log("Close clicked"),
	},
	decorators: [
		createStorybookDecorator({
			expandTaskHeader: true,
			apiConfiguration: {
				actModeApiProvider: "ollama",
				actModeApiModelId: "llama3.2",
			},
			clineMessages: createMessages(),
		}),
	],
}

export const LocalEnvironment: Story = {
	args: {
		task: createTask("Test feature in local environment"),
		totalCost: 0.095,
		onClose: () => console.log("Close clicked"),
	},
	decorators: [
		createStorybookDecorator({
			expandTaskHeader: true,
			environment: Environment.local,
			apiConfiguration: anthropicConfig,
			clineMessages: createMessages(),
		}),
	],
}

export const StagingEnvironment: Story = {
	args: {
		task: createTask("Deploy to staging environment"),
		totalCost: 0.115,
		onClose: () => console.log("Close clicked"),
	},
	decorators: [
		createStorybookDecorator({
			expandTaskHeader: true,
			environment: Environment.staging,
			apiConfiguration: anthropicConfig,
			clineMessages: createMessages(),
		}),
	],
}

export const ProductionEnvironment: Story = {
	args: {
		task: createTask("Deploy to production environment"),
		totalCost: 0.135,
		onClose: () => console.log("Close clicked"),
	},
	decorators: [
		createStorybookDecorator({
			expandTaskHeader: true,
			environment: Environment.production,
			apiConfiguration: anthropicConfig,
			clineMessages: createMessages(),
		}),
	],
}

export const MinimalTask: Story = {
	args: {
		task: createTask("Fix typo"),
		totalCost: 0.005,
		onClose: () => console.log("Close clicked"),
	},
	decorators: [
		createStorybookDecorator({
			expandTaskHeader: true,
			apiConfiguration: anthropicConfig,
			clineMessages: [
				{
					ts: Date.now() - 60000,
					type: "say",
					say: "task",
					text: "Fix typo",
				},
				{
					ts: Date.now() - 30000,
					type: "say",
					say: "text",
					text: "Fixed the typo.",
				},
			],
		}),
	],
}
