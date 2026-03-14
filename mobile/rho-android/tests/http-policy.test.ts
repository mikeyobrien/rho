import { evaluateHttpPolicy } from "../src/http-policy";

describe("HTTP Policy Module", () => {
	it("allows public HTTPS without confirmation", () => {
		const result = evaluateHttpPolicy({
			name: "Prod",
			scheme: "https",
			host: "rho.example.com",
		});
		expect(result).toEqual({ allowed: true, requiresConfirm: false });
	});

	it("requires confirmation for localhost HTTP", () => {
		const result = evaluateHttpPolicy({
			name: "Local",
			scheme: "http",
			host: "localhost",
		});
		expect(result.allowed).toBe(true);
		if (result.requiresConfirm) {
			expect(result.warningMessage).toMatch(/localhost/i);
		} else {
			fail("Expected confirmation for localhost");
		}
	});

	it("requires confirmation for LAN HTTP", () => {
		const result = evaluateHttpPolicy({
			name: "Home Server",
			scheme: "http",
			host: "192.168.1.5",
		});
		expect(result.allowed).toBe(true);
		if (result.requiresConfirm) {
			expect(result.warningMessage).toMatch(/local network address/i);
		} else {
			fail("Expected confirmation for LAN");
		}
	});

	it("requires confirmation for Tailscale ts.net hosts", () => {
		const result = evaluateHttpPolicy({
			name: "Tailnet",
			scheme: "http",
			host: "rho-box.example-tailnet.ts.net",
		});
		expect(result.allowed).toBe(true);
		if (result.requiresConfirm) {
			expect(result.warningMessage).toMatch(/tailscale/i);
		} else {
			fail("Expected confirmation for ts.net host");
		}
	});

	it("requires confirmation for Tailscale CGNAT addresses", () => {
		const result = evaluateHttpPolicy({
			name: "Tailnet IP",
			scheme: "http",
			host: "100.101.102.103",
		});
		expect(result.allowed).toBe(true);
		if (result.requiresConfirm) {
			expect(result.warningMessage).toMatch(/tailscale/i);
		} else {
			fail("Expected confirmation for CGNAT host");
		}
	});

	it("requires confirmation for bare MagicDNS-style hostnames", () => {
		const result = evaluateHttpPolicy({
			name: "MagicDNS",
			scheme: "http",
			host: "tidepool",
		});
		expect(result.allowed).toBe(true);
		if (result.requiresConfirm) {
			expect(result.warningMessage).toMatch(/private name|tailscale/i);
		} else {
			fail("Expected confirmation for bare MagicDNS-style host");
		}
	});

	it("blocks public HTTP outright", () => {
		const result = evaluateHttpPolicy({
			name: "Insecure Prod",
			scheme: "http",
			host: "rho.example.com",
		});
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.blockMessage).toMatch(/public HTTP profiles are blocked/i);
		} else {
			fail("Expected public HTTP to be blocked");
		}
	});
});
