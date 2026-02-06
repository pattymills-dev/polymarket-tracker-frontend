// Deno Edge Function to sync Polymarket market resolutions
import { createClient } from 'supabase'

console.log('sync-market-resolutions v5 starting')

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const url = new URL(req.url)
    const batchSize = parseInt(url.searchParams.get('batch') || '50', 10)
    const mode = url.searchParams.get('mode') || 'recent' // 'recent' prioritizes traded markets, 'all' does oldest first
    const forceFallback = url.searchParams.get('force_fallback') === '1'
    const marketIdParam = url.searchParams.get('market_id')
    const recentDays = parseInt(url.searchParams.get('days') || '7', 10)
    const debugEnabled = url.searchParams.get('debug') === '1'

    console.log(`Processing batch of ${batchSize} markets in ${mode} mode`)

    // Initialize Supabase client with service role
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    let unresolvedMarkets: any[] = []
    let marketsError: any = null

    if (marketIdParam) {
      const { data, error } = await supabase
        .from('markets')
        .select('id, question, slug, resolved, winning_outcome')
        .eq('id', marketIdParam)
        .limit(1)

      unresolvedMarkets = data || []
      marketsError = error
    } else if (mode === 'recent') {
      // PRIORITY MODE: Get markets that have trades in the last 7 days
      // These are the ones users actually care about
      // NOTE: A PostgREST join can be extremely duplicate-heavy (many trades per market),
      // which means `limit(batchSize)` may only yield a handful of unique markets.
      // We instead pull recent trades, dedupe market_ids in-memory, then fetch the
      // corresponding unresolved markets.

      const tradeSampleLimit = Math.max(batchSize * 50, 2000) // enough trades to yield many unique market_ids
      const tradeLookbackIso = new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000).toISOString()

      const { data: recentTrades, error: recentTradesError } = await supabase
        .from('trades')
        .select('market_id,timestamp')
        .not('market_id', 'is', null)
        .gte('timestamp', tradeLookbackIso)
        .order('timestamp', { ascending: false })
        .limit(tradeSampleLimit)

      if (!recentTradesError && Array.isArray(recentTrades) && recentTrades.length > 0) {
        const seenMarketIds = new Set<string>()
        const orderedMarketIds: string[] = []
        const maxMarketIds = Math.min(Math.max(batchSize * 5, batchSize), 600)

        for (const t of recentTrades) {
          const id = (t as any)?.market_id
          if (typeof id !== 'string' || id.length === 0) continue
          if (seenMarketIds.has(id)) continue
          seenMarketIds.add(id)
          orderedMarketIds.push(id)
          // Pull more than batchSize because many may already be resolved,
          // but cap to keep PostgREST URL sizes reasonable.
          if (orderedMarketIds.length >= maxMarketIds) break
        }

        if (orderedMarketIds.length > 0) {
          const idx = new Map(orderedMarketIds.map((id, i) => [id, i]))
          const candidates: any[] = []
          const chunkSize = 150

          for (let start = 0; start < orderedMarketIds.length; start += chunkSize) {
            const chunk = orderedMarketIds.slice(start, start + chunkSize)
            const { data: chunkMarkets, error: chunkError } = await supabase
              .from('markets')
              .select('id, question, slug, resolved, winning_outcome')
              .in('id', chunk)
              .or('resolved.eq.false,winning_outcome.is.null')

            if (chunkError) continue
            if (Array.isArray(chunkMarkets) && chunkMarkets.length > 0) {
              candidates.push(...chunkMarkets)
            }

            // If we already have plenty of candidates, stop early.
            if (candidates.length >= batchSize * 2) break
          }

          if (candidates.length > 0) {
            unresolvedMarkets = candidates
              .sort((a: any, b: any) => (idx.get(a.id) ?? 0) - (idx.get(b.id) ?? 0))
              .slice(0, batchSize)
          }
        }
      }

      if ((!unresolvedMarkets || unresolvedMarkets.length === 0) && !forceFallback) {
        const { data, error } = await supabase.rpc('get_unresolved_markets_with_recent_trades', {
          p_days: recentDays,
          p_limit: batchSize
        })

        if (error) {
          // Fallback if RPC doesn't exist - use a join query approach
          console.log('RPC not found, using fallback query')
        } else if (data && data.length > 0) {
          unresolvedMarkets = data || []
        }
      }

      if (!unresolvedMarkets || unresolvedMarkets.length === 0) {
        const { data: fallbackData, error: fallbackError } = await supabase
          .from('markets')
          .select(`
            id, question, slug, resolved, winning_outcome,
            trades!inner(timestamp)
          `)
          .or('resolved.eq.false,winning_outcome.is.null')
          .gte('trades.timestamp', tradeLookbackIso)
          .order('timestamp', { ascending: false, foreignTable: 'trades' })
          .limit(batchSize)

        if (fallbackError) {
          // Final fallback - just get unresolved markets ordered by most recent update
          console.log('Fallback query failed, using simple query')
          const { data: simpleData, error: simpleError } = await supabase
            .from('markets')
            .select('id, question, slug, resolved, winning_outcome')
            .or('resolved.eq.false,winning_outcome.is.null')
            .order('updated_at', { ascending: false }) // Most recently updated first
            .limit(batchSize)

          unresolvedMarkets = simpleData || []
          marketsError = simpleError
        } else {
          // Dedupe markets (join may return duplicates)
          const seen = new Set()
          unresolvedMarkets = (fallbackData || []).filter((m: any) => {
            if (seen.has(m.id)) return false
            seen.add(m.id)
            return true
          })
        }
      }
    } else {
      // ALL MODE: Process oldest unresolved markets first (for backfill)
      const { data, error } = await supabase
        .from('markets')
        .select('id, question, slug, resolved, winning_outcome')
        .or('resolved.eq.false,winning_outcome.is.null')
        .order('updated_at', { ascending: true, nullsFirst: true })
        .limit(batchSize)

      unresolvedMarkets = data || []
      marketsError = error
    }

    if (marketsError) {
      console.error('Error fetching markets:', marketsError)
      return new Response(JSON.stringify({ error: marketsError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const markets = unresolvedMarkets || []

    console.log(`Fetched ${markets.length} markets needing resolution updates`)

    if (markets.length === 0) {
      console.log('No markets needing resolution updates found')
      return new Response(JSON.stringify({ ok: true, processed: 0, updated: 0 }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    let updatedCount = 0
    let checkedCount = 0
    let errorCount = 0
    const debugRows: any[] = []

    // Process markets in parallel batches of 10 to speed things up
    const parallelBatchSize = 10
    for (let i = 0; i < markets.length; i += parallelBatchSize) {
      const batch = markets.slice(i, i + parallelBatchSize)

      const results = await Promise.allSettled(batch.map(async (market: any) => {
        try {
          let gammaMarket: any = null

          if (market.slug) {
            const gammaUrl = `https://gamma-api.polymarket.com/markets/slug/${market.slug}`
            const gammaResponse = await fetch(gammaUrl, {
              headers: { 'Accept': 'application/json' }
            })

            if (gammaResponse.ok) {
              gammaMarket = await gammaResponse.json()
            }
          }

          if (!gammaMarket && market.id) {
            // Fallback: fetch by conditionId (Gamma accepts single condition_ids)
            const byIdUrl = `https://gamma-api.polymarket.com/markets?condition_ids=${market.id}`
            const byIdResponse = await fetch(byIdUrl, {
              headers: { 'Accept': 'application/json' }
            })

            if (byIdResponse.ok) {
              const byIdMarkets = await byIdResponse.json()
              if (Array.isArray(byIdMarkets) && byIdMarkets.length > 0) {
                gammaMarket = byIdMarkets[0]
              }
            }
          }

          if (!gammaMarket) {
            console.log(`Market ${market.slug || market.id} not found in Gamma API`)
            return { checked: true, updated: false }
          }

          const parseMaybeJson = (value: any) => {
            if (value == null) return null
            if (typeof value === 'string') {
              try {
                return JSON.parse(value)
              } catch {
                return value
              }
            }
            return value
          }

          const outcomesRaw = parseMaybeJson(gammaMarket.outcomes)
          const outcomePricesRaw = parseMaybeJson(gammaMarket.outcomePrices)
          const outcomes = Array.isArray(outcomesRaw) ? outcomesRaw : null
          const outcomePrices = Array.isArray(outcomePricesRaw)
            ? outcomePricesRaw.map((value: any) => Number(value))
            : null

          const resolutionStatus = String(gammaMarket.umaResolutionStatus || '').toLowerCase()
          const resolutionStatusesRaw = parseMaybeJson(gammaMarket.umaResolutionStatuses)
          const resolutionStatuses = Array.isArray(resolutionStatusesRaw)
            ? resolutionStatusesRaw.map((value: any) => String(value).toLowerCase())
            : []

          const isResolvedByStatus =
            resolutionStatus === 'resolved' || resolutionStatuses.includes('resolved')

          const hasOutcomePrices =
            Array.isArray(outcomePrices) &&
            outcomePrices.length > 0 &&
            outcomePrices.some((value) => Number.isFinite(value))

          // Only treat prices as a final resolution signal when they are effectively settled
          // (one outcome ~1.0 and the rest ~0.0). Otherwise, outcomePrices are just market prices.
          const looksSettledPrices = (() => {
            if (!hasOutcomePrices) return false
            const prices = outcomePrices as number[]
            const max = Math.max(...prices)
            const min = Math.min(...prices)
            if (!(max >= 0.999 && min <= 0.001)) return false
            return prices.every((p) => p >= 0.999 || p <= 0.001)
          })()

          const winningOutcomeRaw =
            gammaMarket.winningOutcome ||
            gammaMarket.winning_outcome ||
            gammaMarket.resolvedOutcome ||
            gammaMarket.resolution

          let winningOutcome =
            typeof winningOutcomeRaw === 'string' && winningOutcomeRaw.length > 0
              ? winningOutcomeRaw
              : null

          if (!winningOutcome && looksSettledPrices && Array.isArray(outcomes)) {
            const maxPrice = Math.max(...outcomePrices!)
            const winningIndexes = outcomePrices!.reduce<number[]>((acc, price, idx) => {
              if (price === maxPrice) acc.push(idx)
              return acc
            }, [])

            if (winningIndexes.length === 1) {
              winningOutcome = outcomes[winningIndexes[0]]
            }
          }

          const isResolved =
            gammaMarket.resolved === true ||
            isResolvedByStatus ||
            Boolean(winningOutcomeRaw) ||
            looksSettledPrices

          if (debugEnabled && debugRows.length < 5) {
            debugRows.push({
              market: { id: market.id, slug: market.slug },
              gamma: {
                slug: gammaMarket.slug,
                closed: gammaMarket.closed,
                active: gammaMarket.active,
                umaResolutionStatus: gammaMarket.umaResolutionStatus,
                umaResolutionStatuses: gammaMarket.umaResolutionStatuses,
                outcomePrices: gammaMarket.outcomePrices,
                outcomes: gammaMarket.outcomes,
                winningOutcomeRaw: winningOutcomeRaw ?? null,
              },
              decision: {
                isResolvedByStatus,
                looksSettledPrices,
                winningOutcome,
                isResolved,
              },
            })
          }

          if (isResolved && winningOutcome) {
            console.log(`Market ${market.slug || market.id} resolved: winner = ${winningOutcome}`)

            const resolvedAt =
              gammaMarket.closed_time ||
              gammaMarket.closedTime ||
              gammaMarket.resolvedTime ||
              new Date().toISOString()

            // Update market as resolved
            const { error: updateError } = await supabase
              .from('markets')
              .update({
                resolved: true,
                resolved_at: resolvedAt,
                winning_outcome: winningOutcome,
                slug: market.slug || gammaMarket.slug || null,
                question: market.question || gammaMarket.question || gammaMarket.title || null,
                updated_at: new Date().toISOString()
              })
              .eq('id', market.id)

            if (updateError) {
              console.error(`Error updating market ${market.id}:`, updateError)
              return { checked: true, updated: false, error: true }
            }

            return { checked: true, updated: true }
          }

          if (isResolved && !winningOutcome) {
            console.log(
              `Market ${market.slug || market.id} appears resolved but has no winning outcome yet`
            )
          }

          {
            // Market not yet resolved, update timestamp so it moves down the queue
            await supabase
              .from('markets')
              .update({
                updated_at: new Date().toISOString(),
                slug: market.slug || gammaMarket.slug || null,
                question: market.question || gammaMarket.question || gammaMarket.title || null
              })
              .eq('id', market.id)

            return { checked: true, updated: false }
          }
        } catch (error) {
          console.error(`Error processing market ${market.slug}:`, error)
          return { checked: true, updated: false, error: true }
        }
      }))

      // Tally results
      for (const result of results) {
        if (result.status === 'fulfilled') {
          if (result.value.checked) checkedCount++
          if (result.value.updated) updatedCount++
          if (result.value.error) errorCount++
        } else {
          errorCount++
        }
      }

      // Small delay between batches to avoid rate limiting
      if (i + parallelBatchSize < markets.length) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    console.log(`Checked ${checkedCount} markets, resolved ${updatedCount}, errors ${errorCount}`)

    return new Response(JSON.stringify({
      ok: true,
      processed: checkedCount,
      updated: updatedCount,
      errors: errorCount,
      total_queried: markets.length,
      debug: debugEnabled ? debugRows : undefined,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('Unexpected error:', error)
    return new Response(JSON.stringify({
      error: error.message || 'Unknown error'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
