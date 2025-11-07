import 'dotenv/config';
import { Seaport } from '@opensea/seaport-js';
import { ethers } from 'ethers';

const OPENSEA_FEE_RATE = 0.01; // 1% buyer fee

export interface SniperConfig {
  collectionSlug: string;
  /**
   * Maximum total price (including OpenSea buyer fee) the sniper will pay for a listing.
   */
  maxPriceInEth: number;
  /**
   * Desired discount (in percent) relative to the floor price, measured on total spend including fees.
   */
  discountPercent: number;
  pollingIntervalMs: number;
  rpcUrl: string;
  walletPrivateKey: string;
  openseaApiKey?: string;
  /**
   * How long to wait for OpenSea responses before abandoning the request. Keeping this tight
   * helps reduce total latency introduced by slow network calls.
   */
  requestTimeoutMs?: number;
}

interface Listing {
  price: number;
  orderHash: string;
  maker: string;
  protocolData: any;
}

interface CollectionStats {
  floor_price: number | null;
}

interface CollectionResponse {
  stats: CollectionStats;
}

interface ListingsResponse {
  listings: Array<{
    price: {
      currency: string;
      amount: string;
    };
    order_hash: string;
    maker: string;
    protocol_data: any;
  }>;
}

const OPENSEA_API_BASE = 'https://api.opensea.io/api/v2';

export class NftFloorSniper {
  private readonly config: SniperConfig;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly wallet: ethers.Wallet;
  private readonly seaport: Seaport;
  private pollingHandle?: NodeJS.Timeout;
  private readonly processedOrders = new Set<string>();
  private isChecking = false;

  constructor(config: SniperConfig) {
    this.config = config;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.wallet = new ethers.Wallet(config.walletPrivateKey, this.provider);
    this.seaport = new Seaport(this.wallet);
  }

  start(): void {
    if (this.pollingHandle) {
      throw new Error('Sniper already running');
    }
    this.pollingHandle = setInterval(() => {
      void this.checkAndSnipe();
    }, this.config.pollingIntervalMs);
    void this.checkAndSnipe();
  }

  stop(): void {
    if (this.pollingHandle) {
      clearInterval(this.pollingHandle);
      this.pollingHandle = undefined;
    }
  }

  private async checkAndSnipe(): Promise<void> {
    if (this.isChecking) {
      return;
    }
    this.isChecking = true;

    try {
      const [floor, listings] = await Promise.all([
        this.fetchFloorPrice(),
        this.fetchListings(),
      ]);

      if (!floor) {
        console.warn('Unable to determine floor price, skipping iteration.');
        return;
      }

      const discountFraction = this.toDiscountFraction(this.config.discountPercent);
      const floorWithFees = floor * (1 + OPENSEA_FEE_RATE);
      const targetTotalSpend = floorWithFees * (1 - discountFraction);

      const discounted = listings
        .filter((listing) => !this.processedOrders.has(listing.orderHash))
        .filter((listing) => {
          const totalSpend = this.calculateTotalSpend(listing.price);
          return totalSpend <= targetTotalSpend && totalSpend <= this.config.maxPriceInEth;
        })
        .sort((a, b) => a.price - b.price);

      await Promise.all(
        discounted.map(async (listing) => {
          console.log(
            `Found discounted listing: ${listing.orderHash} @ ${listing.price} ETH (maker: ${listing.maker})`,
          );
          this.processedOrders.add(listing.orderHash);
          try {
            await this.executePurchase(listing);
          } finally {
            if (this.processedOrders.size > 500) {
              this.trimProcessedOrders();
            }
          }
        }),
      );
    } catch (error) {
      console.error('Polling failed:', error);
    } finally {
      this.isChecking = false;
    }
  }

  private async fetchFloorPrice(): Promise<number | null> {
    const url = `${OPENSEA_API_BASE}/collections/${this.config.collectionSlug}/stats`;
    const response = await this.fetchWithTimeout(url, {
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch floor price: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as CollectionResponse;
    return payload.stats.floor_price;
  }

  private async fetchListings(): Promise<Listing[]> {
    const url = new URL(
      `${OPENSEA_API_BASE}/listings/collection/${this.config.collectionSlug}/all`,
    );
    url.searchParams.set('limit', '50');
    url.searchParams.set('order_by', 'eth_price');
    url.searchParams.set('order_direction', 'asc');

    const response = await this.fetchWithTimeout(url, {
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch listings: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as ListingsResponse;
    return payload.listings
      .filter((listing) => listing.price.currency === 'ETH')
      .map((listing) => ({
        price: Number.parseFloat(listing.price.amount),
        orderHash: listing.order_hash,
        maker: listing.maker,
        protocolData: listing.protocol_data,
      }));
  }

  private calculateTotalSpend(listingPrice: number): number {
    return listingPrice * (1 + OPENSEA_FEE_RATE);
  }

  private trimProcessedOrders(): void {
    const entries = [...this.processedOrders];
    this.processedOrders.clear();
    for (const orderHash of entries.slice(Math.max(0, entries.length - 250))) {
      this.processedOrders.add(orderHash);
    }
  }

  private toDiscountFraction(discountPercent: number): number {
    if (discountPercent < 0 || discountPercent >= 100) {
      throw new Error('discountPercent must be between 0 (inclusive) and 100 (exclusive)');
    }
    return discountPercent / 100;
  }

  private async executePurchase(listing: Listing): Promise<void> {
    try {
      const { actions } = await this.seaport.createFulfillmentActions({
        orderHash: listing.orderHash,
        accountAddress: this.wallet.address,
        protocolAddress: listing.protocolData.parameters?.considerationToken ?? undefined,
      });

      for (const action of actions) {
        console.log(`Executing action: ${action.type}`);
        const tx = await action.transact();
        console.log('Submitted transaction', tx.hash);
        const receipt = await tx.wait();
        console.log('Transaction confirmed in block', receipt.blockNumber);
      }
    } catch (error) {
      console.error('Failed to execute purchase:', error);
    }
  }

  private buildHeaders(): HeadersInit {
    const headers: HeadersInit = {
      accept: 'application/json',
    };

    if (this.config.openseaApiKey) {
      headers['x-api-key'] = this.config.openseaApiKey;
    }

    return headers;
  }

  private async fetchWithTimeout(resource: string | URL, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs ?? 4000);
    try {
      return await fetch(resource, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function bootstrap(): void {
  if (process.env.BOOTSTRAP === 'false') {
    return;
  }

  const config: SniperConfig = {
    collectionSlug: requireEnv('COLLECTION_SLUG'),
    maxPriceInEth: Number(requireEnv('MAX_PRICE_ETH')),
    discountPercent: Number(requireEnv('DISCOUNT_PERCENT')),
    pollingIntervalMs: Number(requireEnv('POLLING_INTERVAL_MS')),
    rpcUrl: requireEnv('RPC_URL'),
    walletPrivateKey: requireEnv('WALLET_PRIVATE_KEY'),
    openseaApiKey: process.env.OPENSEA_API_KEY,
    requestTimeoutMs: process.env.REQUEST_TIMEOUT_MS
      ? Number(process.env.REQUEST_TIMEOUT_MS)
      : undefined,
  };

  const sniper = new NftFloorSniper(config);
  sniper.start();

  process.on('SIGINT', () => {
    console.log('Stopping sniper...');
    sniper.stop();
    process.exit(0);
  });
}

bootstrap();
