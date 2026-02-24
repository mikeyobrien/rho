export function evaluateHttpPolicy(profile) {
    if (profile.scheme === 'https') {
        return { allowed: true, requiresConfirm: false };
    }
    // HTTP policy
    const isLocalhost = profile.host === 'localhost' || profile.host === '127.0.0.1' || profile.host === '::1';
    const isLan = profile.host.startsWith('192.168.') || profile.host.startsWith('10.') || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(profile.host) || profile.host.endsWith('.local');
    if (isLocalhost) {
        return {
            allowed: true,
            requiresConfirm: true,
            warningMessage: `Connecting to localhost over HTTP is insecure but common for development. Continue connecting to ${profile.name}?`
        };
    }
    else if (isLan) {
        return {
            allowed: true,
            requiresConfirm: true,
            warningMessage: `Connecting to a local network address over HTTP is insecure. Credentials may be intercepted by others on your network. Continue connecting to ${profile.name}?`
        };
    }
    else {
        return {
            allowed: true,
            requiresConfirm: true,
            warningMessage: `WARNING: Connecting to a public address over HTTP is highly insecure. Your token will be transmitted in plaintext and can be easily intercepted. Continue connecting to ${profile.name} at your own risk?`
        };
    }
}
