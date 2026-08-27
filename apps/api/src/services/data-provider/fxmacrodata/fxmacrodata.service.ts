import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import {
  DataProviderInterface,
  GetAssetProfileParams,
  GetDividendsParams,
  GetHistoricalParams,
  GetQuotesParams,
  GetSearchParams
} from '@ghostfolio/api/services/data-provider/interfaces/data-provider.interface';
import { FetchService } from '@ghostfolio/api/services/fetch/fetch.service';
import { DATE_FORMAT } from '@ghostfolio/common/helper';
import {
  DataProviderHistoricalResponse,
  DataProviderInfo,
  DataProviderResponse,
  LookupResponse
} from '@ghostfolio/common/interfaces';

import { Injectable, Logger } from '@nestjs/common';
import { DataSource, SymbolProfile } from '@prisma/client';
import { format } from 'date-fns';

/**
 * FXMacroData serves official daily FX reference rates published by central
 * banks and the BIS. Symbols are six-character currency pairs (USDCHF), which
 * is the shape Ghostfolio already uses for exchange rates, so this provider is
 * a drop-in for DATA_SOURCE_EXCHANGE_RATES.
 *
 * These are end-of-day reference fixings rather than venue prices, so quotes
 * are reported as delayed.
 */
@Injectable()
export class FXMacroDataService implements DataProviderInterface {
  private static readonly BASE_URL = 'https://api.fxmacrodata.com/v1';
  private static readonly MAX_ROWS_PER_REQUEST = 100;

  // The published currency universe. Held locally so an unsupported pair is
  // skipped without an HTTP request.
  private static readonly CURRENCIES = new Set([
    'AUD',
    'BRL',
    'CAD',
    'CHF',
    'CNH',
    'CNY',
    'DKK',
    'EUR',
    'GBP',
    'ILS',
    'JPY',
    'NGN',
    'NOK',
    'NZD',
    'PEN',
    'SEK',
    'THB',
    'USD'
  ]);

  private readonly logger = new Logger(FXMacroDataService.name);

  public constructor(
    private readonly configurationService: ConfigurationService,
    private readonly fetchService: FetchService
  ) {}

  public canHandle() {
    return !!this.configurationService.get('API_KEY_FXMACRODATA');
  }

  public async getAssetProfile({
    symbol
  }: GetAssetProfileParams): Promise<Partial<SymbolProfile>> {
    const currencyPair = FXMacroDataService.parseCurrencyPair(symbol);

    return {
      symbol,
      currency: currencyPair?.quote,
      dataSource: this.getName()
    };
  }

  public getDataProviderInfo(): DataProviderInfo {
    return {
      dataSource: DataSource.FXMACRODATA,
      isPremium: true,
      name: 'FXMacroData',
      url: 'https://fxmacrodata.com'
    };
  }

  public async getDividends({}: GetDividendsParams) {
    return {};
  }

  public async getHistorical({
    from,
    requestTimeout = this.configurationService.get('REQUEST_TIMEOUT'),
    symbol,
    to
  }: GetHistoricalParams): Promise<{
    [date: string]: DataProviderHistoricalResponse;
  }> {
    const currencyPair = FXMacroDataService.parseCurrencyPair(symbol);

    if (!currencyPair) {
      return {};
    }

    const response: { [date: string]: DataProviderHistoricalResponse } = {};

    try {
      let page = 1;

      while (true) {
        const payload = await this.request({
          requestTimeout,
          path: `forex/${currencyPair.base}/${currencyPair.quote}`,
          searchParams: {
            end_date: format(to, DATE_FORMAT),
            limit: `${FXMacroDataService.MAX_ROWS_PER_REQUEST}`,
            page: `${page}`,
            start_date: format(from, DATE_FORMAT)
          }
        });

        const rows = Array.isArray(payload?.data) ? payload.data : [];

        for (const row of rows) {
          const marketPrice = Number(row?.val);

          if (row?.date && Number.isFinite(marketPrice)) {
            response[row.date] = { marketPrice };
          }
        }

        if (
          !payload?.pagination?.has_more ||
          rows.length === 0 ||
          page >= 100
        ) {
          break;
        }

        page += 1;
      }

      return response;
    } catch (error) {
      throw new Error(
        `Could not get historical market data for ${symbol} (${this.getName()}) from ${format(
          from,
          DATE_FORMAT
        )} to ${format(to, DATE_FORMAT)}: [${error.name}] ${error.message}`
      );
    }
  }

  public getMaxNumberOfSymbolsPerRequest() {
    // One currency pair per request.
    return 1;
  }

  public getName(): DataSource {
    return DataSource.FXMACRODATA;
  }

  public async getQuotes({
    requestTimeout = this.configurationService.get('REQUEST_TIMEOUT'),
    symbols
  }: GetQuotesParams): Promise<{ [symbol: string]: DataProviderResponse }> {
    const response: { [symbol: string]: DataProviderResponse } = {};

    if (symbols.length <= 0) {
      return response;
    }

    await Promise.all(
      symbols.map(async (symbol) => {
        const currencyPair = FXMacroDataService.parseCurrencyPair(symbol);

        if (!currencyPair) {
          return;
        }

        try {
          const payload = await this.request({
            requestTimeout,
            path: `forex/${currencyPair.base}/${currencyPair.quote}`,
            searchParams: { limit: '1' }
          });

          const marketPrice = Number(payload?.data?.[0]?.val);

          if (Number.isFinite(marketPrice)) {
            response[symbol] = {
              marketPrice,
              currency: currencyPair.quote,
              dataProviderInfo: this.getDataProviderInfo(),
              dataSource: this.getName(),
              // Reference rates are published once per day.
              marketState: 'delayed'
            };
          }
        } catch (error) {
          this.logger.error(
            `Could not get quote for ${symbol}: [${error.name}] ${error.message}`,
            'FXMacroDataService'
          );
        }
      })
    );

    return response;
  }

  public getTestSymbol() {
    return 'USDCHF';
  }

  public async search({}: GetSearchParams): Promise<LookupResponse> {
    // FXMacroData serves currency pairs rather than tradable instruments, so
    // there is nothing to look up here.
    return { items: [] };
  }

  private async request({
    path,
    requestTimeout,
    searchParams
  }: {
    path: string;
    requestTimeout: number;
    searchParams: Record<string, string>;
  }) {
    const queryParams = new URLSearchParams(searchParams);

    const response = await this.fetchService.fetch(
      `${FXMacroDataService.BASE_URL}/${path}?${queryParams.toString()}`,
      {
        headers: {
          // Header transport keeps the key out of URLs and access logs.
          'X-API-Key': this.configurationService.get('API_KEY_FXMACRODATA')
        },
        signal: AbortSignal.timeout(requestTimeout)
      }
    );

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * `USDCHF` -> `{ base: 'USD', quote: 'CHF' }`, or undefined when the symbol
   * is not a currency pair FXMacroData publishes.
   */
  private static parseCurrencyPair(symbol: string) {
    if (symbol?.length !== 6) {
      return undefined;
    }

    const base = symbol.slice(0, 3).toUpperCase();
    const quote = symbol.slice(3).toUpperCase();

    if (
      base === quote ||
      !FXMacroDataService.CURRENCIES.has(base) ||
      !FXMacroDataService.CURRENCIES.has(quote)
    ) {
      return undefined;
    }

    return { base, quote };
  }
}
