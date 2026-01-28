import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { logger } from '../server/logger.js';

// ============================================================================
// TOKEN-WALLET MAPPING STORE
// ============================================================================

interface TokenRecord {
  walletAddress: string;
  createdAt: number;
  lastUsed: number;
}

const tokens = new Map<string, TokenRecord>();

// JWT secret - in production, use a secure secret from environment
const JWT_SECRET = process.env.JWT_SECRET || 'akash-gateway-secret-change-in-production';

// ============================================================================
// TOKEN OPERATIONS
// ============================================================================

/**
 * Generate a JWT token for a wallet address
 */
export function generateToken(walletAddress: string): string {
  const normalizedAddress = walletAddress.toLowerCase();

  const token = jwt.sign(
    {
      wallet: normalizedAddress,
      iat: Math.floor(Date.now() / 1000),
    },
    JWT_SECRET,
    {
      expiresIn: '365d', // Long-lived token - user can revoke via allowance
      issuer: 'akash-gateway',
    }
  );

  // Store token mapping
  tokens.set(token, {
    walletAddress: normalizedAddress,
    createdAt: Date.now(),
    lastUsed: Date.now(),
  });

  logger.info({ wallet: normalizedAddress }, 'Token generated for wallet');

  return token;
}

/**
 * Verify a token and return the wallet address
 */
export function verifyToken(token: string): {
  valid: boolean;
  walletAddress?: string;
  error?: string;
} {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      issuer: 'akash-gateway',
    }) as { wallet: string };

    // Update last used
    const record = tokens.get(token);
    if (record) {
      record.lastUsed = Date.now();
    }

    return {
      valid: true,
      walletAddress: decoded.wallet,
    };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return { valid: false, error: 'Token expired' };
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return { valid: false, error: 'Invalid token' };
    }
    return { valid: false, error: 'Token verification failed' };
  }
}

/**
 * Get wallet address from token (without full verification - for internal use)
 */
export function getWalletFromToken(token: string): string | null {
  try {
    const decoded = jwt.decode(token) as { wallet: string } | null;
    return decoded?.wallet || null;
  } catch {
    return null;
  }
}

/**
 * Revoke a token
 */
export function revokeToken(token: string): boolean {
  const deleted = tokens.delete(token);
  if (deleted) {
    logger.info('Token revoked');
  }
  return deleted;
}

/**
 * Get token stats
 */
export function getTokenStats(): {
  totalTokens: number;
  activeTokens: number;
} {
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;

  let activeTokens = 0;
  for (const record of tokens.values()) {
    if (now - record.lastUsed < oneDay) {
      activeTokens++;
    }
  }

  return {
    totalTokens: tokens.size,
    activeTokens,
  };
}
