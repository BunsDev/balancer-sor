import { BigNumber, formatFixed, parseFixed } from '@ethersproject/bignumber';
import { WeiPerEther as ONE, Zero } from '@ethersproject/constants';
import { isSameAddress } from '../../utils';
import {
    BigNumber as OldBigNumber,
    bnum,
    scale,
    ZERO,
} from '../../utils/bignumber';
import {
    PoolBase,
    PoolTypes,
    SwapPairType,
    SwapTypes,
    SubgraphPoolBase,
    SubgraphToken,
} from '../../types';
import { getAddress } from '@ethersproject/address';
import * as SDK from '@georgeroman/balancer-v2-pools';
import {
    _invariant,
    _spotPriceAfterSwapExactTokenInForTokenOut,
    _spotPriceAfterSwapTokenInForExactTokenOut,
    _derivativeSpotPriceAfterSwapExactTokenInForTokenOut,
    _derivativeSpotPriceAfterSwapTokenInForExactTokenOut,
    _spotPriceAfterSwapTokenInForExactBPTOut,
    _spotPriceAfterSwapBPTInForExactTokenOut,
    _derivativeSpotPriceAfterSwapExactTokenInForBPTOut,
    _derivativeSpotPriceAfterSwapExactBPTInForTokenOut,
    _derivativeSpotPriceAfterSwapTokenInForExactBPTOut,
    _derivativeSpotPriceAfterSwapBPTInForExactTokenOut,
} from './metaStableMath';
import { StablePoolPairData } from '../stablePool/stablePool';
import {
    _spotPriceAfterSwapExactTokenInForBPTOut,
    _spotPriceAfterSwapExactBPTInForTokenOut,
    _exactBPTInForTokenOut,
} from './metaStableMath';
import { cloneDeep } from 'lodash';

export enum PairTypes {
    BptToToken,
    TokenToBpt,
    TokenToToken,
}

type MetaStablePoolToken = Pick<
    SubgraphToken,
    'address' | 'balance' | 'decimals' | 'priceRate'
>;

export type MetaStablePoolPairData = StablePoolPairData & {
    tokenInPriceRate: BigNumber;
    tokenOutPriceRate: BigNumber;
};

export class MetaStablePool implements PoolBase {
    poolType: PoolTypes = PoolTypes.MetaStable;
    swapPairType: SwapPairType;
    id: string;
    address: string;
    amp: BigNumber;
    swapFee: BigNumber;
    totalShares: BigNumber;
    tokens: MetaStablePoolToken[];
    tokensList: string[];
    AMP_PRECISION = BigNumber.from('1000');
    MAX_IN_RATIO = parseFixed('0.3', 18);
    MAX_OUT_RATIO = parseFixed('0.3', 18);
    ampAdjusted: BigNumber;

    static fromPool(pool: SubgraphPoolBase): MetaStablePool {
        if (!pool.amp) throw new Error('MetaStablePool missing amp factor');
        return new MetaStablePool(
            pool.id,
            pool.address,
            pool.amp,
            pool.swapFee,
            pool.totalShares,
            pool.tokens,
            pool.tokensList
        );
    }

    constructor(
        id: string,
        address: string,
        amp: string,
        swapFee: string,
        totalShares: string,
        tokens: MetaStablePoolToken[],
        tokensList: string[]
    ) {
        this.id = id;
        this.address = address;
        this.amp = parseFixed(amp, 0);
        this.swapFee = parseFixed(swapFee, 18);
        this.totalShares = parseFixed(totalShares, 18);
        this.tokens = tokens;
        this.tokensList = tokensList;
        this.ampAdjusted = this.amp.mul(this.AMP_PRECISION);
    }

    setTypeForSwap(type: SwapPairType): void {
        this.swapPairType = type;
    }

    parsePoolPairData(
        tokenIn: string,
        tokenOut: string
    ): MetaStablePoolPairData {
        const tokenIndexIn = this.tokens.findIndex(
            (t) => getAddress(t.address) === getAddress(tokenIn)
        );
        if (tokenIndexIn < 0) throw 'Pool does not contain tokenIn';
        const tI = this.tokens[tokenIndexIn];
        // balanceIn = tI.balance;
        const balanceIn = bnum(tI.balance).times(bnum(tI.priceRate)).toString();
        const decimalsIn = tI.decimals;
        const tokenInPriceRate = parseFixed(tI.priceRate, 18);

        const tokenIndexOut = this.tokens.findIndex(
            (t) => getAddress(t.address) === getAddress(tokenOut)
        );
        if (tokenIndexOut < 0) throw 'Pool does not contain tokenOut';
        const tO = this.tokens[tokenIndexOut];
        // balanceOut = tO.balance;
        const balanceOut = bnum(tO.balance)
            .times(bnum(tO.priceRate))
            .toString();
        const decimalsOut = tO.decimals;
        const tokenOutPriceRate = parseFixed(tO.priceRate, 18);

        // Get all token balances
        const allBalances = this.tokens.map(({ balance, priceRate }) =>
            bnum(balance).times(priceRate)
        );
        const allBalancesScaled = this.tokens.map(({ balance, priceRate }) =>
            parseFixed(balance, 18).mul(parseFixed(priceRate, 18)).div(ONE)
        );

        // Metastable pools allow trading between token and pool BPT
        let pairType: PairTypes;
        if (isSameAddress(tokenIn, this.address)) {
            pairType = PairTypes.BptToToken;
        } else if (isSameAddress(tokenOut, this.address)) {
            pairType = PairTypes.TokenToBpt;
        } else {
            pairType = PairTypes.TokenToToken;
        }
        let bptIndex = this.tokensList.indexOf(this.address);

        const inv = _invariant(this.amp, allBalances);

        const poolPairData: MetaStablePoolPairData = {
            id: this.id,
            address: this.address,
            poolType: this.poolType,
            pairType: pairType,
            bptIndex: bptIndex,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            balanceIn: parseFixed(balanceIn, decimalsIn),
            balanceOut: parseFixed(balanceOut, decimalsOut),
            invariant: inv,
            swapFee: this.swapFee,
            allBalances,
            allBalancesScaled,
            amp: this.amp,
            tokenIndexIn: tokenIndexIn,
            tokenIndexOut: tokenIndexOut,
            decimalsIn: Number(decimalsIn),
            decimalsOut: Number(decimalsOut),
            tokenInPriceRate,
            tokenOutPriceRate,
        };

        return poolPairData;
    }

    getNormalizedLiquidity(poolPairData: MetaStablePoolPairData): OldBigNumber {
        // This is an approximation as the actual normalized liquidity is a lot more complicated to calculate
        return bnum(
            formatFixed(
                poolPairData.balanceOut.mul(poolPairData.amp),
                poolPairData.decimalsOut
            )
        );
    }

    getLimitAmountSwap(
        poolPairData: MetaStablePoolPairData,
        swapType: SwapTypes
    ): OldBigNumber {
        // We multiply ratios by 10**-18 because we are in normalized space
        // so 0.5 should be 0.5 and not 500000000000000000
        // TODO: update bmath to use everything normalized
        // PoolPairData is using balances that have already been exchanged so need to convert back
        if (swapType === SwapTypes.SwapExactIn) {
            /*            if (poolPairData.pairType == PairTypes.BptToToken) {
                return bnum(formatFixed(poolPairData.balanceIn,poolPairData.decimalsIn));
            }
            else if (poolPairData.pairType == PairTypes.TokenToBpt) {
                return bnum(Infinity);
            }
            else */
            return bnum(
                formatFixed(
                    poolPairData.balanceIn
                        .mul(this.MAX_IN_RATIO)
                        .div(poolPairData.tokenInPriceRate),
                    poolPairData.decimalsIn
                )
            );
        } else {
            return bnum(
                formatFixed(
                    poolPairData.balanceOut
                        .mul(this.MAX_OUT_RATIO)
                        .div(poolPairData.tokenOutPriceRate),
                    poolPairData.decimalsOut
                )
            );
        }
    }

    // Updates the balance of a given token for the pool
    updateTokenBalanceForPool(token: string, newBalance: BigNumber): void {
        // token is BPT
        if (this.address == token) {
            this.totalShares = newBalance;
        } else {
            // token is underlying in the pool
            const T = this.tokens.find((t) => isSameAddress(t.address, token));
            if (!T) throw Error('Pool does not contain this token');
            T.balance = formatFixed(newBalance, T.decimals);
        }
    }

    _exactTokenInForTokenOut(
        poolPairData: MetaStablePoolPairData,
        amount: OldBigNumber,
        exact: boolean
    ): OldBigNumber {
        try {
            // All values should use 1e18 fixed point
            // i.e. 1USDC => 1e18 not 1e6
            const amtScaled = scale(amount, 18);
            const amountConverted = amtScaled.times(
                formatFixed(poolPairData.tokenInPriceRate, 18)
            );

            let ampAdjusted = bnum(this.ampAdjusted.toString());
            let balances = removeBPT(poolPairData).allBalancesScaled.map(
                (balance) => bnum(balance.toString())
            );
            let swapFee = bnum(poolPairData.swapFee.toString());
            let totalShares = bnum(this.totalShares.toString());
            let amt: OldBigNumber;

            if (poolPairData.pairType === PairTypes.TokenToBpt) {
                let amountsIn: OldBigNumber[] = [];
                for (let i = 0; i < balances.length - 1; i++) {
                    // The following might fail if there was BPT among balances
                    // with an index lower than tokenIndexIn
                    let newValue =
                        i == poolPairData.tokenIndexIn ? amountConverted : ZERO;
                    amountsIn.push(newValue);
                }
                amt = SDK.StableMath._calcBptOutGivenExactTokensIn(
                    ampAdjusted,
                    balances,
                    amountsIn,
                    totalShares,
                    swapFee
                );
            } else if (poolPairData.pairType === PairTypes.BptToToken) {
                amt = SDK.StableMath._calcTokenOutGivenExactBptIn(
                    ampAdjusted,
                    balances,
                    poolPairData.tokenIndexOut,
                    amountConverted,
                    totalShares,
                    swapFee
                );
            } else {
                amt = SDK.StableMath._calcOutGivenIn(
                    ampAdjusted,
                    balances,
                    poolPairData.tokenIndexIn,
                    poolPairData.tokenIndexOut,
                    amountConverted,
                    swapFee
                );
            }

            // return normalised amount
            // Using BigNumber.js decimalPlaces (dp), allows us to consider token decimal accuracy correctly,
            // i.e. when using token with 2decimals 0.002 should be returned as 0
            // Uses ROUND_DOWN mode (1)
            return scale(
                amt.div(formatFixed(poolPairData.tokenOutPriceRate, 18)),
                -18
            ).dp(poolPairData.decimalsOut, 1);
        } catch (err) {
            console.error(`_evmoutGivenIn: ${err.message}`);
            return ZERO;
        }
    }

    // TO DO: modify this function to support BPT swaps similar to _exactTokenInForTokenOut
    _tokenInForExactTokenOut(
        poolPairData: MetaStablePoolPairData,
        amount: OldBigNumber,
        exact: boolean
    ): OldBigNumber {
        try {
            // All values should use 1e18 fixed point
            // i.e. 1USDC => 1e18 not 1e6
            const amtScaled = scale(amount, 18);
            const amountConverted = amtScaled.times(
                formatFixed(poolPairData.tokenOutPriceRate, 18)
            );

            const amt = SDK.StableMath._calcInGivenOut(
                bnum(this.ampAdjusted.toString()),
                poolPairData.allBalancesScaled.map((balance) =>
                    bnum(balance.toString())
                ),
                poolPairData.tokenIndexIn,
                poolPairData.tokenIndexOut,
                amountConverted,
                bnum(poolPairData.swapFee.toString())
            );

            // return normalised amount
            // Using BigNumber.js decimalPlaces (dp), allows us to consider token decimal accuracy correctly,
            // i.e. when using token with 2decimals 0.002 should be returned as 0
            // Uses ROUND_UP mode (0)
            return scale(
                amt.div(formatFixed(poolPairData.tokenInPriceRate, 18)),
                -18
            ).dp(poolPairData.decimalsIn, 0);
        } catch (err) {
            console.error(`_evminGivenOut: ${err.message}`);
            return ZERO;
        }
    }

    _spotPriceAfterSwapExactTokenInForTokenOut(
        poolPairData: MetaStablePoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        const amountConverted = amount.times(
            formatFixed(poolPairData.tokenInPriceRate, 18)
        );
        let result: OldBigNumber;
        if (poolPairData.pairType === PairTypes.TokenToBpt) {
            result = _spotPriceAfterSwapExactTokenInForBPTOut(
                amount,
                removeBPT(poolPairData)
            );
        } else if (poolPairData.pairType === PairTypes.BptToToken) {
            result = _spotPriceAfterSwapExactBPTInForTokenOut(
                amount,
                removeBPT(poolPairData)
            );
        } else {
            result = _spotPriceAfterSwapExactTokenInForTokenOut(
                amountConverted,
                removeBPT(poolPairData)
            );
        }
        return result;
    }

    _spotPriceAfterSwapTokenInForExactTokenOut(
        poolPairData: MetaStablePoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        const amountConverted = amount.times(
            formatFixed(poolPairData.tokenOutPriceRate, 18)
        );
        let result: OldBigNumber;
        if (poolPairData.pairType === PairTypes.TokenToBpt) {
            result = _spotPriceAfterSwapTokenInForExactBPTOut(
                amount,
                removeBPT(poolPairData)
            );
        } else if (poolPairData.pairType === PairTypes.BptToToken) {
            result = _spotPriceAfterSwapBPTInForExactTokenOut(
                amount,
                removeBPT(poolPairData)
            );
        } else {
            result = _spotPriceAfterSwapTokenInForExactTokenOut(
                amountConverted,
                removeBPT(poolPairData)
            );
        }
        return result;
    }

    _derivativeSpotPriceAfterSwapExactTokenInForTokenOut(
        poolPairData: MetaStablePoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        const amountConverted = amount.times(
            formatFixed(poolPairData.tokenInPriceRate, 18)
        );
        let result: OldBigNumber;
        if (poolPairData.pairType === PairTypes.TokenToBpt) {
            result = _derivativeSpotPriceAfterSwapExactTokenInForBPTOut(
                amount,
                removeBPT(poolPairData)
            );
        } else if (poolPairData.pairType === PairTypes.BptToToken) {
            result = _derivativeSpotPriceAfterSwapExactBPTInForTokenOut(
                amount,
                removeBPT(poolPairData)
            );
        } else {
            result = _derivativeSpotPriceAfterSwapExactTokenInForTokenOut(
                amountConverted,
                removeBPT(poolPairData)
            );
        }
        return result;
    }

    _derivativeSpotPriceAfterSwapTokenInForExactTokenOut(
        poolPairData: MetaStablePoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        const amountConverted = amount.times(
            formatFixed(poolPairData.tokenOutPriceRate, 18)
        );
        let result: OldBigNumber;
        if (poolPairData.pairType === PairTypes.TokenToBpt) {
            result = _derivativeSpotPriceAfterSwapTokenInForExactBPTOut(
                amount,
                removeBPT(poolPairData)
            );
        } else if (poolPairData.pairType === PairTypes.BptToToken) {
            result = _derivativeSpotPriceAfterSwapBPTInForExactTokenOut(
                amount,
                removeBPT(poolPairData)
            );
        } else {
            result = _derivativeSpotPriceAfterSwapTokenInForExactTokenOut(
                amountConverted,
                removeBPT(poolPairData)
            );
        }
        return result;
    }
}

function removeBPT(
    poolPairData: MetaStablePoolPairData
): MetaStablePoolPairData {
    let ans = cloneDeep(poolPairData);
    let bptIndex = poolPairData.bptIndex;
    if (bptIndex) {
        ans.allBalances.splice(bptIndex);
        ans.allBalancesScaled.splice(bptIndex);
    }
    return ans;
}
