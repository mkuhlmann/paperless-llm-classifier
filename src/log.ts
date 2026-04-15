import { createConsola } from 'consola';
import { LogLayer } from 'loglayer';
import { ConsolaTransport } from '@loglayer/transport-consola';

export const logger = new LogLayer({
	transport: new ConsolaTransport({
		logger: createConsola({
			level: 5, // Enable all log levels
		}),
	}),
});
