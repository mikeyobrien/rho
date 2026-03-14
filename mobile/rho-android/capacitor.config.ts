import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
	appId: "dev.rhobot.rhoandroid",
	appName: "rho",
	webDir: "www",
	server: {
		androidScheme: "http",
		// Dynamic host profiles require runtime navigation beyond localhost.
		allowNavigation: ["*"],
	},
};

export default config;
