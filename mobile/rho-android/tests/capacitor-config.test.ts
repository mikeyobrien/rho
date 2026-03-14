import config from "../capacitor.config";

describe("Capacitor config", () => {
	it("sets appName to rho", () => {
		expect(config.appName).toBe("rho");
	});
});
