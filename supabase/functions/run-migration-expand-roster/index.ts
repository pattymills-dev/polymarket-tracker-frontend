import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRole);

    console.log("Starting copy trader roster expansion migration...");

    // Step 1: Disable all traders
    const { error: disableError } = await supabase
      .from("copy_traders")
      .update({ enabled: false })
      .neq("trader_address", "");

    if (disableError) {
      throw new Error(`Failed to disable traders: ${disableError.message}`);
    }
    console.log("✓ Disabled all existing traders");

    // Step 2: Find eligible traders (top 10 by P/L with quality gates)
    const { data: eligibleTraders, error: eligibleError } = await supabase.rpc(
      "get_top_copy_candidates",
      {
        min_roi: 0.20,
        min_trades: 25,
        min_confidence: 2.0,
        max_rank: 25,
        max_age_hours: 48,
        lookback_days: 7,
        top_n: 10,
      }
    );

    // If the RPC doesn't exist, fall back to direct SQL query
    if (eligibleError?.code === "42883") {
      console.log("RPC not found, using direct query...");

      const { data: rankings, error: rankError } = await supabase
        .from("trader_rankings")
        .select("trader_address, realized_pl_30d, realized_roi_30d, resolved_trades_30d, confidence_30d, copyable_rank_30d, computed_at")
        .gte("realized_roi_30d", 0.20)
        .gte("resolved_trades_30d", 25)
        .gte("confidence_30d", 2)
        .lte("copyable_rank_30d", 25)
        .gte("computed_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
        .order("realized_pl_30d", { ascending: false })
        .limit(20); // Get top 20, we'll filter for activity

      if (rankError) {
        throw new Error(`Failed to fetch rankings: ${rankError.message}`);
      }

      if (!rankings?.length) {
        return new Response(
          JSON.stringify({
            success: false,
            message: "No eligible traders found meeting criteria",
            enabled_count: 0,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Filter for recent activity
      const activeTraders = [];
      for (const trader of rankings) {
        const { data: recentTrades } = await supabase
          .from("trades")
          .select("id")
          .eq("wallet_address", trader.trader_address)
          .gte("timestamp", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
          .limit(1);

        if (recentTrades?.length) {
          activeTraders.push(trader);
          if (activeTraders.length >= 10) break;
        }
      }

      // Step 3: Enable the top 10
      const enabledAddresses = activeTraders.map(t => t.trader_address);

      if (enabledAddresses.length > 0) {
        const { error: enableError } = await supabase
          .from("copy_traders")
          .update({ enabled: true })
          .in("trader_address", enabledAddresses);

        if (enableError) {
          throw new Error(`Failed to enable traders: ${enableError.message}`);
        }
      }

      // Step 4: Insert any missing traders
      for (const trader of activeTraders) {
        const { error: upsertError } = await supabase
          .from("copy_traders")
          .upsert({
            trader_address: trader.trader_address,
            enabled: true,
            copy_factor: 0.1,
            min_usd: 10,
            max_usd: 500,
            max_trader_exposure_pct: 0.25,
            per_trader_cooldown_minutes: 5,
            min_price: 0.30,
            max_price: 0.85,
            price_penalty: 0.01,
            allow_sells: false,
            cooldown_minutes: 1,
            max_copyable_rank_30d: 25,
            min_realized_roi_30d: 0.20,
            min_realized_pl_30d: 200,
            min_median_bet_30d: 25,
            min_resolved_trades_30d: 25,
            min_confidence_30d: 2.0,
            max_open_positions: 8,
            previous_rank_30d: trader.copyable_rank_30d,
          }, {
            onConflict: "trader_address",
          });

        if (upsertError) {
          console.warn(`Failed to upsert trader ${trader.trader_address}: ${upsertError.message}`);
        }
      }

      console.log(`✓ Enabled ${activeTraders.length} traders`);

      // Step 5: Fetch final roster
      const { data: finalRoster, error: rosterError } = await supabase
        .from("copy_traders")
        .select(`
          trader_address,
          enabled,
          min_price,
          max_price,
          max_open_positions
        `)
        .eq("enabled", true)
        .order("trader_address");

      if (rosterError) {
        console.warn("Failed to fetch final roster:", rosterError.message);
      }

      // Get stats for enabled traders
      const { data: stats } = await supabase
        .from("trader_rankings")
        .select("trader_address, realized_pl_30d, realized_roi_30d, resolved_trades_30d, copyable_rank_30d")
        .in("trader_address", enabledAddresses);

      const roster = finalRoster?.map(ct => {
        const stat = stats?.find(s => s.trader_address === ct.trader_address);
        return {
          ...ct,
          ...stat,
        };
      }) || [];

      return new Response(
        JSON.stringify({
          success: true,
          message: `Successfully enabled ${activeTraders.length} traders`,
          enabled_count: activeTraders.length,
          roster: roster.sort((a, b) => (b.realized_pl_30d || 0) - (a.realized_pl_30d || 0)),
        }, null, 2),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // If RPC exists, use its results
    if (eligibleError) {
      throw new Error(`Failed to get eligible traders: ${eligibleError.message}`);
    }

    // Enable the traders returned by RPC
    const enabledAddresses = (eligibleTraders || []).map((t: any) => t.trader_address);

    if (enabledAddresses.length > 0) {
      const { error: enableError } = await supabase
        .from("copy_traders")
        .update({ enabled: true })
        .in("trader_address", enabledAddresses);

      if (enableError) {
        throw new Error(`Failed to enable traders: ${enableError.message}`);
      }
    }

    console.log(`✓ Enabled ${enabledAddresses.length} traders`);

    // Fetch final roster
    const { data: finalRoster, error: rosterError } = await supabase
      .from("copy_traders")
      .select("*")
      .eq("enabled", true);

    if (rosterError) {
      throw new Error(`Failed to fetch final roster: ${rosterError.message}`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Successfully enabled ${enabledAddresses.length} traders`,
        enabled_count: enabledAddresses.length,
        roster: finalRoster,
      }, null, 2),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Migration failed:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
