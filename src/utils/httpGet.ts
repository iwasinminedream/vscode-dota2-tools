import * as https from 'https';

/** GET a URL over HTTPS and return the body as UTF-8 text; follows redirects, rejects on any status but 200 */
export function httpGet(url: string, headers: { [name: string]: string; } = {}, timeoutMs = 60000, redirects = 5): Promise<string> {
	return new Promise((resolve, reject) => {
		const request = https.get(url, { headers: { 'User-Agent': 'dota2tools-vscode', ...headers }, timeout: timeoutMs }, (response) => {
			const status = response.statusCode ?? 0;
			if (status >= 300 && status < 400 && response.headers.location && redirects > 0) {
				response.resume();
				resolve(httpGet(new URL(response.headers.location, url).toString(), headers, timeoutMs, redirects - 1));
				return;
			}
			if (status !== 200) {
				response.resume();
				reject(new Error(`HTTP ${status}: ${url}`));
				return;
			}
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
			response.on('error', reject);
		});
		request.on('timeout', () => request.destroy(new Error(`Timed out: ${url}`)));
		request.on('error', reject);
	});
}
