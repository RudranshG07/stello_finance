/**
 * Tests for monitoring utilities
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkDatabaseHealth,
  checkRedisHealth,
  checkStellarHealth,
  checkContractHealth,
  getSystemMetrics,
  performHealthCheck,
  trackPerformance,
  sendAlert,
  monitorHealth,
  HealthCheckResult
} from '../src/utils/monitoring';

describe('Monitoring Utilities', () => {
  describe('checkDatabaseHealth', () => {
    it('should return healthy status for successful database check', async () => {
      const mockPrisma = {
        $queryRaw: vi.fn().mockResolvedValue([{ result: 1 }])
      };

      const result = await checkDatabaseHealth(mockPrisma);

      expect(result.status).toBe('up');
      expect(result.latency).toBeDefined();
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it('should return down status for failed database check', async () => {
      const mockPrisma = {
        $queryRaw: vi.fn().mockRejectedValue(new Error('Connection failed'))
      };

      const result = await checkDatabaseHealth(mockPrisma);

      expect(result.status).toBe('down');
      expect(result.error).toBe('Connection failed');
    });

    it('should return degraded status for slow database response', async () => {
      const mockPrisma = {
        $queryRaw: vi.fn().mockImplementation(() => 
          new Promise(resolve => setTimeout(() => resolve([{ result: 1 }]), 150))
        )
      };

      const result = await checkDatabaseHealth(mockPrisma);

      expect(result.status).toBe('degraded');
      expect(result.latency).toBeGreaterThan(100);
    });
  });

  describe('checkRedisHealth', () => {
    it('should return healthy status for successful Redis check', async () => {
      const mockRedis = {
        ping: vi.fn().mockResolvedValue('PONG')
      };

      const result = await checkRedisHealth(mockRedis);

      expect(result.status).toBe('up');
      expect(result.latency).toBeDefined();
    });

    it('should return down status for failed Redis check', async () => {
      const mockRedis = {
        ping: vi.fn().mockRejectedValue(new Error('Redis unavailable'))
      };

      const result = await checkRedisHealth(mockRedis);

      expect(result.status).toBe('down');
      expect(result.error).toBe('Redis unavailable');
    });
  });

  describe('checkStellarHealth', () => {
    beforeEach(() => {
      global.fetch = vi.fn();
    });

    it('should return healthy status for successful Stellar check', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200
      });

      const result = await checkStellarHealth('https://horizon-testnet.stellar.org');

      expect(result.status).toBe('up');
      expect(result.latency).toBeDefined();
    });

    it('should return down status for failed Stellar check', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 503
      });

      const result = await checkStellarHealth('https://horizon-testnet.stellar.org');

      expect(result.status).toBe('down');
      expect(result.error).toContain('503');
    });

    it('should return down status for network error', async () => {
      (global.fetch as any).mockRejectedValue(new Error('Network error'));

      const result = await checkStellarHealth('https://horizon-testnet.stellar.org');

      expect(result.status).toBe('down');
      expect(result.error).toBe('Network error');
    });
  });

  describe('checkContractHealth', () => {
    beforeEach(() => {
      global.fetch = vi.fn();
    });

    it('should return healthy status for successful contract check', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200
      });

      const result = await checkContractHealth(
        'CDYXKWVDGEVA6OSIGN7GRAPPRN6AKID35OJL5ZZQIBCMECZ35KGL45PS',
        'https://soroban-testnet.stellar.org'
      );

      expect(result.status).toBe('up');
      expect(result.details?.contractId).toBeDefined();
    });

    it('should return degraded status for HTTP error', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 404
      });

      const result = await checkContractHealth(
        'INVALID_CONTRACT_ID',
        'https://soroban-testnet.stellar.org'
      );

      expect(result.status).toBe('degraded');
      expect(result.error).toContain('404');
    });
  });

  describe('getSystemMetrics', () => {
    it('should return system metrics', () => {
      const metrics = getSystemMetrics();

      expect(metrics.uptime).toBeGreaterThanOrEqual(0);
      expect(metrics.memory.used).toBeGreaterThan(0);
      expect(metrics.memory.total).toBeGreaterThan(0);
      expect(metrics.memory.percentage).toBeGreaterThanOrEqual(0);
      expect(metrics.memory.percentage).toBeLessThanOrEqual(100);
      expect(metrics.cpu.percentage).toBeGreaterThanOrEqual(0);
    });
  });

  describe('performHealthCheck', () => {
    it('should return healthy status when all checks pass', async () => {
      const mockPrisma = {
        $queryRaw: vi.fn().mockResolvedValue([{ result: 1 }])
      };
      const mockRedis = {
        ping: vi.fn().mockResolvedValue('PONG')
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200
      });

      const config = {
        horizonUrl: 'https://horizon-testnet.stellar.org',
        rpcUrl: 'https://soroban-testnet.stellar.org',
        stakingContractId: 'CDYXKWVDGEVA6OSIGN7GRAPPRN6AKID35OJL5ZZQIBCMECZ35KGL45PS'
      };

      const result = await performHealthCheck(mockPrisma, mockRedis, config);

      expect(result.status).toBe('healthy');
      expect(result.checks.database.status).toBe('up');
      expect(result.checks.redis.status).toBe('up');
      expect(result.checks.stellar.status).toBe('up');
      expect(result.checks.contracts.status).toBe('up');
    });

    it('should return unhealthy status when any check fails', async () => {
      const mockPrisma = {
        $queryRaw: vi.fn().mockRejectedValue(new Error('DB down'))
      };
      const mockRedis = {
        ping: vi.fn().mockResolvedValue('PONG')
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200
      });

      const config = {
        horizonUrl: 'https://horizon-testnet.stellar.org',
        rpcUrl: 'https://soroban-testnet.stellar.org',
        stakingContractId: 'CDYXKWVDGEVA6OSIGN7GRAPPRN6AKID35OJL5ZZQIBCMECZ35KGL45PS'
      };

      const result = await performHealthCheck(mockPrisma, mockRedis, config);

      expect(result.status).toBe('unhealthy');
      expect(result.checks.database.status).toBe('down');
    });
  });

  describe('trackPerformance', () => {
    it('should track successful operation', () => {
      const metric = trackPerformance('test_operation', 100, true, { test: 'data' });

      expect(metric.operation).toBe('test_operation');
      expect(metric.duration).toBe(100);
      expect(metric.success).toBe(true);
      expect(metric.metadata).toEqual({ test: 'data' });
      expect(metric.timestamp).toBeDefined();
    });

    it('should track failed operation', () => {
      const metric = trackPerformance('test_operation', 500, false);

      expect(metric.operation).toBe('test_operation');
      expect(metric.success).toBe(false);
    });

    it('should warn on slow operations', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      trackPerformance('slow_operation', 2000, true);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Slow operation detected')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('sendAlert', () => {
    beforeEach(() => {
      global.fetch = vi.fn();
    });

    it('should log alert to console', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await sendAlert('Test alert', 'info');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Alert][INFO] Test alert')
      );

      consoleSpy.mockRestore();
    });

    it('should send webhook when URL provided', async () => {
      (global.fetch as any).mockResolvedValue({ ok: true });

      await sendAlert('Test alert', 'critical', 'https://webhook.example.com');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://webhook.example.com',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        })
      );
    });

    it('should handle webhook failure gracefully', async () => {
      (global.fetch as any).mockRejectedValue(new Error('Webhook failed'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await sendAlert('Test alert', 'warning', 'https://webhook.example.com');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to send webhook'),
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });
  });

  describe('monitorHealth', () => {
    beforeEach(() => {
      global.fetch = vi.fn();
    });

    it('should send critical alert for unhealthy system', async () => {
      const healthResult: HealthCheckResult = {
        status: 'unhealthy',
        timestamp: Date.now(),
        checks: {
          database: { status: 'down', error: 'Connection failed' },
          redis: { status: 'up' },
          stellar: { status: 'up' },
          contracts: { status: 'up' }
        },
        metrics: getSystemMetrics()
      };

      (global.fetch as any).mockResolvedValue({ ok: true });

      await monitorHealth(healthResult, 'https://webhook.example.com');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://webhook.example.com',
        expect.objectContaining({
          body: expect.stringContaining('System unhealthy')
        })
      );
    });

    it('should send warning alert for degraded system', async () => {
      const healthResult: HealthCheckResult = {
        status: 'degraded',
        timestamp: Date.now(),
        checks: {
          database: { status: 'degraded', latency: 150 },
          redis: { status: 'up' },
          stellar: { status: 'up' },
          contracts: { status: 'up' }
        },
        metrics: getSystemMetrics()
      };

      (global.fetch as any).mockResolvedValue({ ok: true });

      await monitorHealth(healthResult, 'https://webhook.example.com');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://webhook.example.com',
        expect.objectContaining({
          body: expect.stringContaining('System degraded')
        })
      );
    });

    it('should not send alert for healthy system', async () => {
      const healthResult: HealthCheckResult = {
        status: 'healthy',
        timestamp: Date.now(),
        checks: {
          database: { status: 'up' },
          redis: { status: 'up' },
          stellar: { status: 'up' },
          contracts: { status: 'up' }
        },
        metrics: getSystemMetrics()
      };

      await monitorHealth(healthResult, 'https://webhook.example.com');

      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
