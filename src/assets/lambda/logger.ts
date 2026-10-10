import { SecretsManagerServiceException } from '@aws-sdk/client-secrets-manager';
import { SSMServiceException } from '@aws-sdk/client-ssm';
import { JwksValidationError } from '../../shared/jwks';

/** The ECS version the log records follow. */
export const ECS_VERSION = '8.11.0';

/**
 * The closed catalogue of events; see docs/logging.md. Add an entry here
 * before logging a new kind of event, never an ad hoc message.
 */
const EVENTS = {
  start_function: { category: ['process'], type: ['start'] },
  serve_jwks: { category: ['web'], type: ['access'] },
} as const;

export type EventAction = keyof typeof EVENTS;

export type EventOutcome = 'success' | 'failure';

/** Controlled values of `event.reason`. */
export type EventReason = 'method_not_allowed' | 'not_found' | 'source_unavailable';

/** ECS and project fields, by their dotted names. `undefined` values are omitted. */
export type LogFields = Readonly<Record<string, unknown>>;

const TRACE_HEADER_ENV = '_X_AMZN_TRACE_ID';

/** Reads the trace ID from `_X_AMZN_TRACE_ID`, which Lambda sets for each invocation with trace context. */
function xrayTraceId(): string | undefined {
  return /(?:^|;)Root=([^;]+)/.exec(process.env[TRACE_HEADER_ENV] ?? '')?.[1];
}

/**
 * Writes one ECS JSON record to stdout. It is written with `process.stdout`
 * rather than `console.log`, which Lambda's Text log format prefixes with a
 * timestamp, request ID and level. A failure to log never fails a request.
 */
export function logEvent(
  action: EventAction,
  outcome: EventOutcome,
  message: string,
  fields: LogFields = {},
): void {
  try {
    const failure = outcome === 'failure';
    const record = {
      '@timestamp': new Date().toISOString(),
      'log.level': failure ? 'error' : 'info',
      message,
      'ecs.version': ECS_VERSION,
      'service.name': process.env.AWS_LAMBDA_FUNCTION_NAME,
      'cloud.provider': 'aws',
      'cloud.region': process.env.AWS_REGION,
      'event.category': EVENTS[action].category,
      // A failure is an error unless the caller says otherwise (a 4xx is still an access).
      'event.type': failure ? ['error'] : EVENTS[action].type,
      'event.action': action,
      'event.outcome': outcome,
      'aws.xray.trace.id': xrayTraceId(),
      ...fields,
    };
    process.stdout.write(`${JSON.stringify(record)}\n`);
  } catch {
    // Deliberately ignored: logging must never fail a request.
  }
}

/** Errors whose messages this package writes, or AWS writes without echoing values. */
function hasSafeMessage(error: unknown): error is Error {
  return (
    error instanceof JwksValidationError ||
    error instanceof SecretsManagerServiceException ||
    error instanceof SSMServiceException
  );
}

/**
 * `error.type`, plus `error.message` for errors whose messages are safe to log.
 * Other messages might echo their input. No stack trace is logged.
 */
export function errorFields(error: unknown): LogFields {
  return {
    'error.type': error instanceof Error ? error.name : typeof error,
    'error.message': hasSafeMessage(error) ? error.message : undefined,
  };
}
