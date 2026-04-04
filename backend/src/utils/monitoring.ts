/**
 * Monitoring and Health Check Utilities for Stello Fi
 * Provides system health monitoring, performance tracking, and alerting
 */

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: number;
  checks: {
    database: HealthStatus;
    redis: HealthStatus;
    stellar: HealthStatus;
    contracts: HealthStatus;
  };
  metrics: SystemMetrics;
}

export interface HealthStatus {
  status: 'up' | 'down' | 'degraded';
  latency?: number;
  error?: string;
  details?: Record<string, any>;
}

export interface SystemMetrics {
  uptime: number;
  memory: {
    used: number;
    total: number;
    percentage: number;
  };
  cpu: {
    percentage: number;
  };
  requests: {
    total: number;
    success: number;
    failed: number;
    averageLatency: number;
  };
}

export interface PerformanceMetric {
  operation: string;
  duration: number;
  timestamp: number;
  success: boolean;
  metadata?: Record<string, any>;
}

/**
 * Check database health
 */
export async function checkDatabaseHealth(prisma: any): Promise<HealthStatus> {
  const startTime = Date.now();
  
  try {
    await prisma.$queryRaw`SELECT 1`;
    const latency = Date.now() - startTime;
    
    return {
      status: latency < 100 ? 'up' : 'degraded',
      latency,
      details: {
        responseTime: `${latency}ms`
      }
    };
  } catch (error) {
    return {
      status: 'down',
      error: error instanceof Error ? error.message : 'Unknown error',
      latency: Date.now() - startTime
    };
  }
}

/**
 * Check Redis health
 */
export async function checkRedisHealth(redis: any): Promise<HealthStatus> {
  const startTime = Date.now();
  
  try {
    await redis.ping();
    const latency = Date.now() - startTime;
    
    return {
      status: latency < 50 ? 'up' : 'degraded',
      latency,
      details: {
        responseTime: `${latency}ms`
      }
    };
  } catch (error) {
    return {
      status: 'down',
      error: error instanceof Error ? error.message : 'Unknown error',
      latency: Date.now() - startTime
    };
  }
}

/**
 * Check Stellar network health
 */
export async function checkStellarHealth(horizonUrl: string): Promise<HealthStatus> {
  const startTime = Date.now();
  
  try {
    const response = await fetch(`${horizonUrl}/`);
    const latency = Date.now() - startTime;
    
    if (!response.ok) {
      return {
        status: 'down',
        error: `HTTP ${response.status}`,
        latency
      };
    }
    
    return {
      status: latency < 500 ? 'up' : 'degraded',
      latency,
      details: {
        responseTime: `${latency}ms`
      }
    };
  } catch (error) {
    return {
      status: 'down',
      error: error instanceof Error ? error.message : 'Unknown error',
      latency: Date.now() - startTime
    };
  }
}

/**
 * Check smart contract health
 */
export async function checkContractHealth(
  contractId: string,
  rpcUrl: string
): Promise<HealthStatus> {
  const startTime = Date.now();
  
  try {
    // Simple contract existence check
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getContractData',
        params: {
          contractId,
          key: 'any',
          durability: 'persistent'
        }
      })
    });
    
    const latency = Date.now() - startTime;
    
    if (!response.ok) {
      return {
        status: 'degraded',
        error: `HTTP ${response.status}`,
        latency
      };
    }
    
    return {
      status: 'up',
      latency,
      details: {
        contractId,
        responseTime: `${latency}ms`
      }
    };
  } catch (error) {
    return {
      status: 'down',
      error: error instanceof Error ? error.message : 'Unknown error',
      latency: Date.now() - startTime
    };
  }
}

/**
 * Get system metrics
 */
export function getSystemMetrics(): SystemMetrics {
  const memUsage = process.memoryUsage();
  
  return {
    uptime: process.uptime(),
    memory: {
      used: memUsage.heapUsed,
      total: memUsage.heapTotal,
      percentage: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100)
    },
    cpu: {
      percentage: Math.round(process.cpuUsage().user / 1000000) // Convert to percentage
    },
    requests: {
      total: 0, // Should be tracked separately
      success: 0,
      failed: 0,
      averageLatency: 0
    }
  };
}

/**
 * Perform comprehensive health check
 */
export async function performHealthCheck(
  prisma: any,
  redis: any,
  config: {
    horizonUrl: string;
    rpcUrl: string;
    stakingContractId: string;
  }
): Promise<HealthCheckResult> {
  const [dbHealth, redisHealth, stellarHealth, contractHealth] = await Promise.all([
    checkDatabaseHealth(prisma),
    checkRedisHealth(redis),
    checkStellarHealth(config.horizonUrl),
    checkContractHealth(config.stakingContractId, config.rpcUrl)
  ]);

  const checks = {
    database: dbHealth,
    redis: redisHealth,
    stellar: stellarHealth,
    contracts: contractHealth
  };

  // Determine overall status
  const statuses = Object.values(checks).map(c => c.status);
  let overallStatus: 'healthy' | 'degraded' | 'unhealthy';
  
  if (statuses.every(s => s === 'up')) {
    overallStatus = 'healthy';
  } else if (statuses.some(s => s === 'down')) {
    overallStatus = 'unhealthy';
  } else {
    overallStatus = 'degraded';
  }

  return {
    status: overallStatus,
    timestamp: Date.now(),
    checks,
    metrics: getSystemMetrics()
  };
}

/**
 * Track performance metric
 */
export function trackPerformance(
  operation: string,
  duration: number,
  success: boolean,
  metadata?: Record<string, any>
): PerformanceMetric {
  const metric: PerformanceMetric = {
    operation,
    duration,
    timestamp: Date.now(),
    success,
    metadata
  };

  // Log slow operations
  if (duration > 1000) {
    console.warn(`[Performance] Slow operation detected: ${operation} took ${duration}ms`);
  }

  return metric;
}

/**
 * Performance tracking decorator
 */
export function measurePerformance(operationName: string) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const startTime = Date.now();
      let success = true;
      let error: any;

      try {
        const result = await originalMethod.apply(this, args);
        return result;
      } catch (err) {
        success = false;
        error = err;
        throw err;
      } finally {
        const duration = Date.now() - startTime;
        trackPerformance(operationName, duration, success, {
          method: propertyKey,
          error: error?.message
        });
      }
    };

    return descriptor;
  };
}

/**
 * Alert on critical issues
 */
export async function sendAlert(
  message: string,
  severity: 'info' | 'warning' | 'critical',
  webhookUrl?: string
): Promise<void> {
  console.log(`[Alert][${severity.toUpperCase()}] ${message}`);

  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `[${severity.toUpperCase()}] ${message}`,
          timestamp: new Date().toISOString()
        })
      });
    } catch (error) {
      console.error('[Alert] Failed to send webhook:', error);
    }
  }
}

/**
 * Monitor and alert on health check results
 */
export async function monitorHealth(
  healthResult: HealthCheckResult,
  webhookUrl?: string
): Promise<void> {
  if (healthResult.status === 'unhealthy') {
    const downServices = Object.entries(healthResult.checks)
      .filter(([_, status]) => status.status === 'down')
      .map(([service]) => service);

    await sendAlert(
      `System unhealthy! Down services: ${downServices.join(', ')}`,
      'critical',
      webhookUrl
    );
  } else if (healthResult.status === 'degraded') {
    const degradedServices = Object.entries(healthResult.checks)
      .filter(([_, status]) => status.status === 'degraded')
      .map(([service]) => service);

    await sendAlert(
      `System degraded. Affected services: ${degradedServices.join(', ')}`,
      'warning',
      webhookUrl
    );
  }
}
