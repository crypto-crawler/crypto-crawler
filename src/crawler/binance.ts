import { strict as assert } from 'assert';
import WebSocket from 'ws';
import { ExchangeInfo } from 'exchange-info';
import { listenWebSocket, getChannels, initBeforeCrawl } from './util';
import { OrderItem, OrderBookMsg, TradeMsg, BboMsg } from '../pojo/msg';
import { ChannelType, MsgCallback, defaultMsgCallback } from './index';

const EXCHANGE_NAME = 'Binance';

function getChannel(channeltype: ChannelType, pair: string, exchangeInfo: ExchangeInfo): string {
  const pairInfo = exchangeInfo.pairs[pair];
  const rawPair = pairInfo.raw_pair.toLowerCase();
  switch (channeltype) {
    case 'BBO':
      return `${rawPair}@bookTicker`;
    case 'OrderBookUpdate':
      return `${rawPair}@depth`;
    case 'Trade':
      return `${rawPair}@trade`;
    default:
      throw Error(`ChannelType ${channeltype} is not supported for Binance yet`);
  }
}

function getChannelType(channel: string): ChannelType {
  assert.ok(channel.includes('@'));
  const suffix = channel.split('@')[1];
  let result: ChannelType;
  switch (suffix) {
    case 'bookTicker':
      result = 'BBO';
      break;
    case 'depth':
      result = 'OrderBookUpdate';
      break;
    case 'trade':
      result = 'Trade';
      break;
    default:
      throw Error(`Unknown channel: ${channel}`);
  }
  return result;
}

export default async function crawl(
  channelTypes: ChannelType[],
  pairs: string[] = [],
  msgCallback: MsgCallback = defaultMsgCallback,
): Promise<void> {
  const [logger, exchangeInfo, pairMap] = await initBeforeCrawl(EXCHANGE_NAME, pairs);

  const channels = getChannels(channelTypes, pairs, exchangeInfo, getChannel);
  assert.ok(channels.length > 0);

  const websocketUrl = `${exchangeInfo.websocket_endpoint}/stream?streams=${channels.join('/')}`;
  const websocket = new WebSocket(websocketUrl);
  listenWebSocket(
    websocket,
    async data => {
      const raw = data as string;
      const rawMsg: { stream: string; data: { [key: string]: any } } = JSON.parse(raw);
      const channelType = getChannelType(rawMsg.stream);
      switch (channelType) {
        case 'BBO': {
          const rawBookTickerMsg = rawMsg.data as {
            u: number; // order book updateId
            s: string; // symbol
            b: string; // best bid price
            B: string; // best bid qty
            a: string; // best ask price
            A: string; // best ask qty
          };
          const msg: BboMsg = {
            exchange: exchangeInfo.name,
            channel: rawMsg.stream,
            pair: pairMap.get(rawBookTickerMsg.s)!.normalized_pair,
            timestamp: Date.now(),
            raw,
            bidPrice: parseFloat(rawBookTickerMsg.b),
            bidQuantity: parseFloat(rawBookTickerMsg.B),
            askPrice: parseFloat(rawBookTickerMsg.a),
            askQuantity: parseFloat(rawBookTickerMsg.A),
          };
          await msgCallback(msg);
          break;
        }
        case 'OrderBookUpdate': {
          const rawOrderbookMsg = rawMsg.data as {
            e: string;
            E: number;
            s: string;
            U: number;
            u: number;
            b: Array<Array<string>>;
            a: Array<Array<string>>;
          };
          assert.equal(rawOrderbookMsg.e, 'depthUpdate');
          const msg: OrderBookMsg = {
            exchange: exchangeInfo.name,
            channel: rawMsg.stream,
            pair: pairMap.get(rawOrderbookMsg.s)!.normalized_pair,
            timestamp: rawOrderbookMsg.E,
            raw,
            asks: [],
            bids: [],
            full: false,
          };
          const parseOrder = (arr: Array<string>): OrderItem => {
            assert.equal(arr.length, 2);
            const orderItem: OrderItem = {
              price: parseFloat(arr[0]),
              quantity: parseFloat(arr[1]),
              cost: 0,
            };
            orderItem.cost = orderItem.price * orderItem.quantity;
            return orderItem;
          };
          msg.asks = rawOrderbookMsg.a.map((text: Array<string>) => parseOrder(text));
          msg.bids = rawOrderbookMsg.b.map((text: Array<string>) => parseOrder(text));
          await msgCallback(msg);
          break;
        }
        case 'Trade': {
          const rawTradeMsg = rawMsg.data as {
            e: string;
            E: number;
            s: string;
            t: number;
            p: string;
            q: string;
            b: number;
            a: number;
            T: number;
            m: boolean;
            M: boolean;
          };
          assert.equal(rawTradeMsg.e, 'trade');
          const msg: TradeMsg = {
            exchange: exchangeInfo.name,
            channel: rawMsg.stream,
            pair: pairMap.get(rawTradeMsg.s)!.normalized_pair,
            timestamp: rawTradeMsg.T,
            raw,
            price: parseFloat(rawTradeMsg.p),
            quantity: parseFloat(rawTradeMsg.q),
            side: rawTradeMsg.m === false,
            trade_id: rawTradeMsg.t.toString(),
          };
          await msgCallback(msg);
          break;
        }
        default:
          logger.warn(`Unrecognized CrawlType: ${channelType}`);
          logger.warn(rawMsg);
      }
    },
    logger,
  );
}
