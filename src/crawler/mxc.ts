import { strict as assert } from 'assert';
import { MarketType } from 'crypto-markets';
import io from 'socket.io-client';
import { Logger } from 'winston';
import { ChannelType } from '../pojo/channel_type';
import { OrderBookMsg, OrderItem, TradeMsg } from '../pojo/msg';
import createLogger from '../util/logger';
import { defaultMsgCallback, MsgCallback } from './index';

const EXCHANGE_NAME = 'MXC';

interface OrderBookAndTrades {
  symbol: string;
  data: {
    asks?: { p: string; q: string; a: string }[];
    bids?: { p: string; q: string; a: string }[];
    deals?: { t: number; p: string; q: string; T: 1 | 2 }[];
  };
}

function getChannel(channeltype: ChannelType): string {
  switch (channeltype) {
    case 'OrderBook':
    case 'Trade':
      return 'sub.symbol';
    default:
      throw Error(`ChannelType ${channeltype} is not supported for ${EXCHANGE_NAME} yet`);
  }
}

// MXC allows only one pair per connection.
async function crawlOnePair(
  pair: string,
  channelTypes: readonly ChannelType[],
  msgCallback: MsgCallback,
  logger: Logger,
): Promise<void> {
  const socket = io('wss://wbs.mxc.com', {
    autoConnect: false,
    reconnection: true,
    transports: ['websocket'],
  });

  socket.on('connect', () => {
    logger.info('Socket.IO connected');
    const channels = new Set(channelTypes.map((type) => getChannel(type)));
    channels.forEach((channel) => {
      socket.emit(channel, { symbol: pair });
    });
  });

  socket.on('connecting', () => logger.info('Socket.IO connecting...'));
  socket.on('reconnect', () => logger.warn('Socket.IO re-connected'));
  socket.on('connect_timeout', () => logger.error('connect_timeout'));
  socket.on('connect_error', (err: Error) => logger.error(err));
  socket.on('disconnect', () => logger.error('Socket.IO disconnected'));

  socket.on('push.symbol', (data: OrderBookAndTrades) => {
    if (data.data.deals && channelTypes.includes('Trade')) {
      const tradeMsges: TradeMsg[] = data.data.deals.map((x) => ({
        exchange: EXCHANGE_NAME,
        marketType: 'Spot',
        pair: data.symbol,
        rawPair: data.symbol,
        channel: 'sub.symbol',
        channelType: 'Trade',
        timestamp: x.t,
        raw: x,
        price: parseFloat(x.p),
        quantity: parseFloat(x.q),
        side: x.T === 2,
        trade_id: '', // TODO: MXC does NOT have trade ID
      }));

      tradeMsges.forEach(async (tradeMsg) => msgCallback(tradeMsg));
    }

    if ((data.data.asks || data.data.bids) && channelTypes.includes('OrderBook')) {
      const orderBookMsg: OrderBookMsg = {
        exchange: EXCHANGE_NAME,
        marketType: 'Spot',
        pair: data.symbol,
        rawPair: data.symbol,
        channel: 'sub.symbol',
        channelType: 'OrderBook',
        timestamp: Date.now(),
        raw: data,
        asks: [],
        bids: [],
        full: false,
      };
      const parse = (x: { p: string; q: string; a: string }): OrderItem => ({
        price: parseFloat(x.p),
        quantity: parseFloat(x.q),
        cost: parseFloat(x.a),
      });
      if (data.data.asks) {
        orderBookMsg.asks = data.data.asks.map(parse);
      }
      if (data.data.bids) {
        orderBookMsg.bids = data.data.bids.map(parse);
      }

      msgCallback(orderBookMsg);
    }
  });

  socket.open();
}

export default async function crawl(
  marketType: MarketType,
  channelTypes: readonly ChannelType[],
  pairs: readonly string[],
  msgCallback: MsgCallback = defaultMsgCallback,
): Promise<void> {
  assert.equal('Spot', marketType, 'MXC has only Spot market');
  const logger = createLogger(EXCHANGE_NAME);

  await Promise.all(pairs.map((pair) => crawlOnePair(pair, channelTypes, msgCallback, logger)));
}
