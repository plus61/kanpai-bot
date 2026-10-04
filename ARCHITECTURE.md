# Kanpai Bot - Current Architecture

Last updated: 2026-05-12

Kanpai Bot is a LINE group concierge bot for deciding where to eat or drink. It reads group conversations, records recent meals, proposes restaurants, manages simple votes, collects private preferences by DM, and tracks reservation-link taps.

## System Overview

```text
LINE Group / Room / DM
        |
        | POST /webhook
        v
index.js
  - Express app and LINE webhook handler
  - event routing
  - cron/test/track endpoints
        |
        +--> brain.js      OpenAI-based intent, response, and context engine
        +--> search.js     HotPepper search, Google Places fallback, Supabase cache
        +--> flex.js       LINE Flex carousel and affiliate/track URL builder
        +--> memory.js     Supabase data access for messages, state, votes, food history
        +--> kanji.js      autonomous monitor, vote timeout, DM timeout jobs
        +--> collector.js  private DM collection and aggregation
        |
        v
Supabase PostgreSQL
```

## Runtime

- Platform: Node.js + Express
- Deployment target: Vercel serverless via `vercel.json`
- Entry point: `index.js`
- Local dev command: `npm run dev`
- Production start command: `npm start`
- LINE SDK: `@line/bot-sdk`
- AI provider in current code: OpenAI `gpt-4o-mini`
- Restaurant data:
  - HotPepper Gourmet API as primary source
  - Google Places Text Search as fallback
- Database: Supabase PostgreSQL

## HTTP Endpoints

| Endpoint | Method | Purpose |
|---|---:|---|
| `/` | GET | Serves `public/index.html` |
| `/status` | GET | Health/status JSON |
| `/webhook` | POST | LINE webhook event receiver |
| `/cron/dm-timeout` | GET | Closes expired DM collection sessions |
| `/cron/vote-timeout` | GET | Closes old active votes |
| `/cron/monitor` | GET | Runs autonomous group monitor |
| `/track` | GET | Records tap event, then redirects to restaurant URL |
| `/track/stats` | GET | Internal tap stats, protected by `CRON_SECRET` when set |
| `/debug` | POST | Debug echo endpoint |
| `/test/simulate` | POST | Test-only message simulation, protected by `TEST_SECRET` |

Cron endpoints accept either `Authorization: Bearer <CRON_SECRET>` or `?token=Bearer <CRON_SECRET>` when `CRON_SECRET` is configured.

## Main Event Flow

```text
LINE event
  -> index.js /webhook
  -> parse body and compare LINE signature
  -> handleEvent(event)
      |
      +-- group/room text
      |    +-- fetch member display name
      |    +-- memory.logMessage()
      |    +-- memory.touchGroupActivity()
      |    +-- skip pure chitchat
      |    +-- brain.extractFoodFromText()
      |    +-- vote number? -> handleVoteResponse()
      |    +-- @Kanpai? -> handleMention()
      |    +-- DM collection trigger? -> handleDMCollection()
      |    +-- soft signal? -> brain.generateFreeResponse()
      |    +-- food trigger? -> handleFoodSuggestion()
      |    +-- plan context? -> brain.detectPlanContext() + generateProactiveApproach()
      |
      +-- 1:1 DM text
      |    +-- handleDMResponse()
      |
      +-- join event
           +-- send onboarding message
```

## Restaurant Suggestion Flow

```text
handleFoodSuggestion()
  -> memory.getRecentMessages(groupId, 15)
  -> memory.getGroupFoodHistory(groupId, 14)
  -> search.extractArea()
  -> search.extractSearchOptions()
  -> brain.guessGenreFromMessages()
  -> search.extractBudget()
  -> search.searchRestaurants()
       1. Supabase restaurant_cache
       2. HotPepper genre + budget + keyword
       3. HotPepper without lunch filter when needed
       4. HotPepper without budget when needed
       5. HotPepper keyword-only when needed
       6. Google Places fallback
  -> flex.buildRestaurantCarousel()
  -> LINE reply: preamble text + Flex carousel
  -> memory.logMessage(groupId, "bot", "Kanpai", flex.altText)
  -> memory.updateLastBotMessage()
```

If restaurant search or Flex generation fails, the handler falls back to `brain.generateFreeResponse()` or `brain.generateFoodSuggestion()` and may append HotPepper and Tabelog links for concrete requests.

## Module Responsibilities

### `index.js`

Primary server and event router.

- Creates Express app and LINE Messaging API client.
- Creates a Supabase client for tap tracking and direct endpoint work.
- Wires LINE client into `kanji.js` and `collector.js`.
- Starts local cron jobs when `NODE_ENV !== "production"`.
- Handles:
  - webhook parsing and signature comparison
  - group/room message routing
  - DM collection responses
  - mentions
  - food suggestions
  - votes
  - tap tracking
  - test simulation

Important behavior: signature mismatch currently logs a warning and continues. This is MVP behavior, not strict rejection.

### `brain.js`

OpenAI reasoning layer.

- Uses `OPENAI_API_KEY` with model `gpt-4o-mini`.
- Provides:
  - `extractFoodFromText()`
  - `generateFoodSuggestion()`
  - `generateFreeResponse()`
  - `generateIntervention()`
  - `generateVoteResult()`
  - `generateDMBasedSuggestion()`
  - `detectPlanContext()`
  - `generateProactiveApproach()`
  - genre, budget, request-condition, previous-suggestion helpers
- System prompt enforces short Japanese LINE-style responses, no Markdown, no generated URLs, and context-aware restaurant selection.

### `search.js`

Restaurant search and condition extraction.

- Uses `HOTPEPPER_API_KEY` and optional `GOOGLE_PLACES_API_KEY`.
- Maps internal genre codes to HotPepper genre codes.
- Maps budget buckets to HotPepper budget codes.
- Extracts:
  - area from recent messages
  - budget from yen/man-yen expressions
  - options such as lunch, private room, party capacity, vegetarian, chain-avoidance, atmosphere
- Caches successful search results in Supabase `restaurant_cache` for 24 hours.

Note: `supabase/schema.sql` currently does not define `restaurant_cache`, but `search.js` expects it.

### `flex.js`

LINE Flex Message builder.

- Builds restaurant carousel bubbles.
- Adds three actions per restaurant:
  - walk-in style HotPepper redirect through `/track`
  - reservation HotPepper redirect through `/track`
  - Tabelog search URL through ValueCommerce affiliate link
- Uses `BASE_URL` for tracking URLs, defaulting to `https://kanpai-bot.vercel.app`.
- Exports `getTabelogAffiliateUrl()` for text fallback links.

### `memory.js`

Supabase data-access layer for group memory.

- Logs group messages.
- Reads recent messages with a 3-hour conversation-context reset.
- Records food history.
- Reads and updates group state.
- Upserts known group members.
- Creates, records, and closes votes.
- Updates bot and group activity timestamps.

### `kanji.js`

Autonomous concierge engine.

- Receives LINE client through `setLineClient()`.
- Sends group push messages with a 60-minute anti-spam cooldown.
- Provides force-send path for important DM aggregation messages.
- Detects stalemate phrases.
- Monitors active groups from `group_states`.
- Closes expired votes.
- Closes expired DM sessions and pushes aggregate/suggestion messages.
- Starts local `node-cron` schedules outside production:
  - group monitor every 30 minutes
  - vote timeout every 15 minutes
  - DM timeout every 1 minute

### `collector.js`

Private DM preference collection engine.

- Creates `dm_sessions` with 3-minute expiration.
- Finds active collection sessions by user ID.
- Sends DM questions to group members that Kanpai knows.
- Records step-based answers:
  - budget
  - genre
- Aggregates answers when all members respond or the session expires.

## Data Model

Defined in `supabase/schema.sql`:

| Table | Purpose |
|---|---|
| `user_profiles` | LINE user profile storage |
| `group_members` | Known LINE group members |
| `food_history` | Recently eaten items for anti-repeat suggestions |
| `group_messages` | Conversation memory for context and AI prompts |
| `group_states` | Group activity, bot cooldown, current vote, state |
| `votes` | Active/closed vote records |
| `dm_sessions` | Private preference collection sessions |
| `user_follows` | DM send/follow state hints |
| `tap_events` | Walk-in/reservation tap analytics |

Expected by code but missing from `schema.sql`:

| Table | Used by | Purpose |
|---|---|---|
| `restaurant_cache` | `search.js` | 24-hour cache of restaurant search results |

Expected columns for `restaurant_cache` based on code:

```sql
cache_key text primary key,
results jsonb,
area text,
genre text,
budget text,
created_at timestamptz,
expires_at timestamptz
```

## Environment Variables

| Variable | Used by | Purpose |
|---|---|---|
| `LINE_CHANNEL_SECRET` | `index.js` | LINE signature comparison |
| `LINE_CHANNEL_ACCESS_TOKEN` | `index.js` | LINE Messaging API |
| `OPENAI_API_KEY` | `brain.js` | OpenAI chat completions |
| `HOTPEPPER_API_KEY` | `search.js` | HotPepper Gourmet API |
| `GOOGLE_PLACES_API_KEY` | `search.js` | Google Places fallback |
| `SUPABASE_URL` | all data modules | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | all data modules | Preferred Supabase key |
| `SUPABASE_ANON_KEY` | all data modules | Fallback Supabase key |
| `BASE_URL` | `flex.js` | Public base URL for `/track` links |
| `CRON_SECRET` | `index.js` | Cron/stats endpoint protection |
| `TEST_SECRET` | `index.js` | `/test/simulate` protection |
| `PORT` | `index.js` | Local server port |
| `NODE_ENV` | `index.js` | Controls local cron startup |

## Affiliate and Tracking

```text
Flex button tap
  -> /track?type=walkin|reserve&shop_id=...&redirect=...
  -> insert into tap_events
  -> 302 redirect to HotPepper URL
```

Tabelog buttons use ValueCommerce MyLink:

```text
https://ck.jp.ap.valuecommerce.com/servlet/referral
  ?sid=3765360
  &pid=892584846
  &vc_url=<encoded Tabelog search URL>
```

## Deployment Shape

`vercel.json` routes every request to `index.js` through `@vercel/node`.

```text
Vercel edge/request
  -> /(.*)
  -> index.js
```

In production, the code expects external cron calls to `/cron/*`. Local development uses `node-cron` automatically unless `NODE_ENV=production`.

## Known Architecture Notes

- `README.md` still mentions Claude/Anthropic, but the current implementation uses OpenAI `gpt-4o-mini`.
- `ARCHITECTURE.md` previously mentioned `search.js` correctly, but the checked schema is missing `restaurant_cache`.
- `/webhook` compares LINE signatures but does not reject mismatches.
- `/debug` is unprotected.
- `index.js` imports `lineConfig` but does not pass it into LINE middleware; webhook parsing is custom.
- Multiple modules instantiate their own Supabase clients instead of sharing one client.
- `collector.js` stores `member_ids` as JSONB and filters sessions in application code.
