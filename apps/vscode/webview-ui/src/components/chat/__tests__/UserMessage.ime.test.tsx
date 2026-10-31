import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import UserMessage from "../UserMessage"

describe("UserMessage – CEO chat bubble", () => {
	it("renders plain text without edit or reset actions", () => {
		render(<UserMessage images={[]} messageTs={Date.now()} text="hello" />)

		expect(screen.getByTestId("user-message-bubble")).toBeInTheDocument()
		expect(screen.getByText("hello")).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: /reset chat/i })).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: /reset code/i })).not.toBeInTheDocument()
	})

	it("shows attached images without action chrome", () => {
		render(<UserMessage files={[]} images={["image.png"]} messageTs={Date.now()} text="with image" />)

		expect(screen.getByTestId("user-message-bubble")).toBeInTheDocument()
		expect(screen.getByText("with image")).toBeInTheDocument()
		expect(screen.getByAltText("Thumbnail image-1")).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: /reset chat/i })).not.toBeInTheDocument()
	})
})
