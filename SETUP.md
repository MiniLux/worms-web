# Worms Web — Complete Setup Guide

Everything you need to do to run the game, from zero to playable.

## Prerequisites

- Node.js installed (you have v25.2.1)
- A Discord account
- A web browser

---

## Part 1: Discord Developer Portal

1. Go to https://discord.com/developers/applications
2. Log in with your Discord account
3. Click **"New Application"** (top right)
4. Name it `Worms Web`, click **Create**
5. On the left sidebar, click **OAuth2**
6. Under **Client information**, copy and save:
   - **Client ID** (e.g. `1234567890123456`)
   - **Client Secret** (click "Reset Secret" to reveal it, then copy)
7. Under **Redirects**, click **"Add Redirect"** and add:
   ```
   http://localhost:3000/auth/callback
   ```
8. Click **Save Changes**

> Keep this tab open — you'll come back to add the Supabase callback URL.

---

## Part 2: Supabase

### 2a. Create project

1. Go to https://supabase.com and sign up / log in (free)
2. Click **"New Project"**
3. Pick or create an organization
4. Fill in:
   - **Name**: `worms-web`
   - **Database password**: anything strong (save it)
   - **Region**: closest to you
5. Click **"Create new project"** — wait ~2 minutes for provisioning

### 2b. Get your API keys

1. In the Supabase dashboard, go to **Settings** (gear icon, bottom left sidebar) > **API**
2. Copy and save:
   - **Project URL** — e.g. `https://abcdefghij.supabase.co`
   - **anon public key** — long string starting with `eyJhbG...`

### 2c. Enable Discord auth

1. In the dashboard, go to **Authentication** (left sidebar) > **Providers**
2. Find **Discord** and expand it
3. Toggle **Enabled** to ON
4. Paste in the **Client ID** and **Client Secret** from Part 1
5. Click **Save**

### 2d. Add the Supabase callback to Discord

1. Go back to the Discord Developer Portal (Part 1, step 7)
2. Add a second redirect URL:
   ```
   https://<your-project-ref>.supabase.co/auth/v1/callback
   ```
   Replace `<your-project-ref>` with the subdomain from your Project URL
   (e.g. if URL is `https://abcdefghij.supabase.co`, use `abcdefghij`)
3. Click **Save Changes**

### 2e. Create the database tables (optional, for player profiles)

1. In Supabase dashboard, go to **SQL Editor**
2. Click **"New Query"**
3. Paste this SQL and click **Run**:

```sql
create table public.profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  discord_id text unique,
  display_name text not null,
  avatar_url text,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

create policy "Profiles are viewable by all"
  on public.profiles for select to authenticated using (true);

create policy "Users can update own profile"
  on public.profiles for update to authenticated using (auth.uid() = id);

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, discord_id, display_name, avatar_url)
  values (
    new.id,
    new.raw_user_meta_data->>'provider_id',
    coalesce(new.raw_user_meta_data->>'full_name', 'Player'),
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

---

## Part 3: Configure the project

1. Open the file `apps/web/.env.local` and replace the placeholder values:

```env
NEXT_PUBLIC_SUPABASE_URL=https://abcdefghij.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...your-real-anon-key
NEXT_PUBLIC_PARTYKIT_HOST=localhost:1999
```

---

## Part 4: Run the game

```bash
cd /Users/jonathansobota/WormsWeb
pnpm dev
```

This starts two servers:
- **Next.js** at http://localhost:3000 (frontend)
- **PartyKit** at http://localhost:1999 (game server)

### Play:

1. Open http://localhost:3000
2. Click **"Sign in with Discord"**
3. Authorize the app on Discord
4. You land on the **Dashboard**
5. Click **"Create Lobby"** — you get a 6-character code
6. Open a **second browser** (or incognito window), sign in with a different Discord account
7. Enter the lobby code and click **Join**
8. Both players click **Ready**
9. The host clicks **Start Game**
10. The game loads with destructible terrain, worms placed, and turn-based gameplay

---

## Part 5: Sprites (optional upgrade)

The game works out of the box with simple placeholder graphics (colored shapes).
To use real Worms Armageddon sprites:

1. Download the sprite sheet from:
   https://www.spriters-resource.com/pc_computer/wormsgeddon/asset/13597/
   (3.14 MB ZIP — 968 sprites including worms, weapons, effects, icons)

2. Extract the ZIP

3. Place the files in:
   ```
   apps/web/public/assets/sprites/
   ```

4. The sprites will need to be integrated into the Phaser code to replace
   the current placeholder shapes. This is a follow-up task — the game
   engine would need to load the sprite sheets in GameScene.preload()
   and use them in WormEntity/ProjectileEntity instead of drawing shapes.

---

## Part 6: Deploy to the internet (optional)

### 6a. Deploy PartyKit

```bash
cd apps/party
npx partykit login          # login with GitHub
npx partykit deploy          # deploys to worms-party.<username>.partykit.dev
```

Note the URL it prints.

### 6b. Deploy to Vercel

1. Push to GitHub:
   ```bash
   git add -A && git commit -m "initial commit"
   gh repo create WormsWeb --public --push --source .
   ```
2. Go to https://vercel.com, sign in, click **"Add New Project"**
3. Import the `WormsWeb` repo
4. Set:
   - **Root Directory**: `apps/web`
   - **Build Command**: `cd ../.. && pnpm turbo build --filter=@worms/web`
   - **Install Command**: `pnpm install --frozen-lockfile`
5. Add environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL` = your Supabase URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = your anon key
   - `NEXT_PUBLIC_PARTYKIT_HOST` = `worms-party.<username>.partykit.dev`
6. Click **Deploy**

### 6c. Update redirect URLs

After Vercel gives you a URL (e.g. `worms-web.vercel.app`):

1. **Discord Developer Portal** > OAuth2 > Redirects — add:
   ```
   https://worms-web.vercel.app/auth/callback
   ```
2. **Supabase** > Authentication > URL Configuration — add:
   ```
   https://worms-web.vercel.app
   ```
   as an allowed redirect URL.

---

## Total cost: $0

| Service | Free tier limit |
|---------|----------------|
| Vercel | 100 GB bandwidth/month |
| PartyKit | 20 simultaneous connections |
| Supabase | 500 MB database, 50K requests/month |
| Discord OAuth | Unlimited |
