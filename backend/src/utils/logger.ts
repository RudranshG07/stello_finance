/**
 * Centralized Logging System for Stello Fi
 * Provides structured logging with Winston for better observability and debugging
 */

import winston from 'winston';
import { config } from '../config/index.js';

// Define log levels with semantic meaning
export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
}

// Service context for better log filtering
export enum ServiceContext {
  KEEPER = 'keeper',
  RISK_ENGINE = 'risk-engine',
  EVENT_LISTENER = 'event-listener',
  STAKING_ENGINE = 'staking-engine',
  REWARD_ENGINE = 'reward-engine',
  API_GATEWAY = 'api-gateway',
  BRIDGE_RELAYER = 'bridge-relayer',
  METRICS_CRON = 'metrics-cron',
  USER_SERVICE = 'user-service',
  VALIDATOR_SERVICE = 'validator-service',
  LEVERAGE_ENGINE = 'leverage-engine',
  RESTAKING_ENGINE = 'restaking-engine',
  GOVERNANCE_SYNC = 'governance-sync',
  LIQUIDITY_ENGINE = 'liquidity-engine',
  COHORT_AGGREGATOR = 'cohort-aggregator',
  HUBBLE_INDEXER = 'hubble-indexer',
  METRIC_AGGREGATOR = 'metric-aggregator',
  DEX_INTEGRATION = 'dex-integration',
}

// Custom log format with structured data
const customFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss.SSS'
  }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, service, operation, metadata, ...meta }) => {
    const logEntry = {
      timestamp,
      level,
      service,
      operation,
      message,
      ...(Object.keys(meta).length > 0 && { metadata: meta }),
      ...(metadata && { metadata }),
    };

    return JSON.stringify(logEntry);
  })
);

// Create Winston logger instance
const winstonLogger = winston.createLogger({
  level: config.LOG_LEVEL || 'info',
  format: customFormat,
  defaultMeta: { 
    application: 'stello-fi-backend',
    version: process.env.npm_package_version || '1.0.0'
  },
  transports: [
    // Console transport for development
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message, service, operation, metadata, ...meta }) => {
          const serviceStr = service ? `[${service}]` : '';
          const operationStr = operation ? `:${operation}` : '';
          const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
          const metadataStr = metadata ? ` ${JSON.stringify(metadata)}` : '';
          return `${timestamp} ${level}${serviceStr}${operationStr} ${message}${metaStr}${metadataStr}`;
        })
      )
    }),

    // File transport for production
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      )
    }),

    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 5242880, // 5MB
      maxFiles: 10,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      )
    })
  ],

  // Handle uncaught exceptions and unhandled rejections
  exceptionHandlers: [
    new winston.transports.File({ filename: 'logs/exceptions.log' })
  ],
  rejectionHandlers: [
    new winston.transports.File({ filename: 'logs/rejections.log' })
  ]
});

// Logger class with service context
export class Logger {
  private service: ServiceContext;

  constructor(service: ServiceContext) {
    this.service = service;
  }

  // Log error with structured data
  error(message: string, operation?: string, metadata?: Record<string, any>, error?: Error): void {
    const logData: any = {
      service: this.service,
      operation,
      metadata,
    };

    if (error) {
      logData.error = {
        message: error.message,
        stack: error.stack,
        name: error.name
      };
    }

    winstonLogger.error(message, logData);
  }

  // Log warning with structured data
  warn(message: string, operation?: string, metadata?: Record<string, any>): void {
    winstonLogger.warn(message, {
      service: this.service,
      operation,
      metadata
    });
  }

  // Log info with structured data
  info(message: string, operation?: string, metadata?: Record<string, any>): void {
    winstonLogger.info(message, {
      service: this.service,
      operation,
      metadata
    });
  }

  // Log debug with structured data
  debug(message: string, operation?: string, metadata?: Record<string, any>): void {
    winstonLogger.debug(message, {
      service: this.service,
      operation,
      metadata
    });
  }

  // Log performance metrics
  performance(operation: string, duration: number, metadata?: Record<string, any>): void {
    const level = duration > 1000 ? 'warn' : duration > 500 ? 'info' : 'debug';
    winstonLogger[level](`Performance: ${operation} completed in ${duration}ms`, {
      service: this.service,
      operation: 'performance',
      metadata: {
        duration,
        operation,
        ...metadata
      }
    });
  }

  // Log transaction details
  transaction(message: string, txHash: string, operation?: string, metadata?: Record<string, any>): void {
    this.info(message, operation, {
      txHash,
      ...metadata
    });
  }

  // Log financial operations with amounts
  financial(message: string, amount: bigint, asset: string, operation?: string, metadata?: Record<string, any>): void {
    this.info(message, operation, {
      amount: amount.toString(),
      amountFormatted: Number(amount) / 1e7, // Format for XLM (7 decimals)
      asset,
      ...metadata
    });
  }

  // Log health check results
  health(status: 'healthy' | 'degraded' | 'unhealthy', checks: Record<string, any>, metadata?: Record<string, any>): void {
    const level = status === 'unhealthy' ? 'error' : status === 'degraded' ? 'warn' : 'info';
    winstonLogger[level](`Health check: ${status}`, {
      service: this.service,
      operation: 'health-check',
      metadata: {
        status,
        checks,
        ...metadata
      }
    });
  }
}

// Service-specific logger factory
export function getLogger(service: ServiceContext): Logger {
  return new Logger(service);
}

// Default logger for backward compatibility
export const logger = new Logger(ServiceContext.API_GATEWAY);

// Performance tracking helper
export function logPerformance<T>(
  logger: Logger,
  operation: string,
  fn: () => Promise<T>,
  metadata?: Record<string, any>
): Promise<T> {
  return new Promise(async (resolve, reject) => {
    const startTime = Date.now();
    let success = true;
    let error: any;

    try {
      logger.debug(`Starting ${operation}`, operation, metadata);
      const result = await fn();
      const duration = Date.now() - startTime;
      logger.performance(operation, duration, { success: true, ...metadata });
      resolve(result);
    } catch (err) {
      success = false;
      error = err;
      const duration = Date.now() - startTime;
      logger.performance(operation, duration, { success: false, error: err.message, ...metadata });
      logger.error(`Failed ${operation}`, operation, { ...metadata, duration }, err);
      reject(err);
    }
  });
}

// Export winston logger for advanced usage
export { winstonLogger };
