-- =====================================================================
-- DATABASE VOOR FOTOBOEK
-- Plak dit hele bestand in Supabase: SQL Editor > New query > Run.
-- Je hoeft dit maar één keer te doen.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. TABELLEN  (denk aan tabbladen in Excel)
-- ---------------------------------------------------------------------

-- Elk account krijgt een profiel met een gebruikersnaam.
-- is_host = true betekent: deze persoon mag foto's posten.
create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text not null,
  is_host    boolean not null default false,
  created_at timestamptz not null default now()
);

-- De foto's die de host post.
create table public.posts (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  image_path text not null,          -- bestandsnaam in de foto-opslag
  caption    text,                   -- tekst onder de foto
  created_at timestamptz not null default now()
);

-- Likes: één rij per (foto, gebruiker). Dubbel liken kan dus niet.
create table public.likes (
  post_id    bigint not null references public.posts(id) on delete cascade,
  user_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

-- Reacties onder foto's (max. 500 tekens).
create table public.comments (
  id         bigint generated always as identity primary key,
  post_id    bigint not null references public.posts(id) on delete cascade,
  user_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  content    text not null check (char_length(content) between 1 and 500),
  created_at timestamptz not null default now()
);


-- ---------------------------------------------------------------------
-- 2. AUTOMATISCH EEN PROFIEL MAKEN BIJ REGISTRATIE
-- ---------------------------------------------------------------------
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();


-- Hulpfunctie: is de ingelogde persoon de host?
create function public.is_host()
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select coalesce(
    (select is_host from public.profiles where id = auth.uid()),
    false
  );
$$;


-- ---------------------------------------------------------------------
-- 3. BEVEILIGING (Row Level Security)
-- Zonder regel mag niemand iets. Met deze regels bepalen we precies
-- wie wat mag. Dit is het belangrijkste deel van de beveiliging!
-- ---------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.posts    enable row level security;
alter table public.likes    enable row level security;
alter table public.comments enable row level security;

-- Profielen: ingelogde mensen mogen gebruikersnamen zien.
-- Er is bewust GEEN update-regel: niemand kan zichzelf host maken
-- via de website. Dat doe jij handmatig in Supabase.
create policy "Ingelogd: profielen bekijken"
  on public.profiles for select to authenticated using (true);

-- Posts: iedereen die ingelogd is mag kijken, alleen de host mag posten/verwijderen.
create policy "Ingelogd: posts bekijken"
  on public.posts for select to authenticated using (true);
create policy "Host: posts plaatsen"
  on public.posts for insert to authenticated
  with check (public.is_host() and user_id = auth.uid());
create policy "Host: posts verwijderen"
  on public.posts for delete to authenticated using (public.is_host());

-- Likes: iedereen ziet likes, je kunt alleen je eigen like zetten/weghalen.
create policy "Ingelogd: likes bekijken"
  on public.likes for select to authenticated using (true);
create policy "Eigen like zetten"
  on public.likes for insert to authenticated with check (user_id = auth.uid());
create policy "Eigen like weghalen"
  on public.likes for delete to authenticated using (user_id = auth.uid());

-- Reacties: iedereen ziet ze, je plaatst alleen als jezelf,
-- en je mag je eigen reactie verwijderen (de host mag alles verwijderen).
create policy "Ingelogd: reacties bekijken"
  on public.comments for select to authenticated using (true);
create policy "Eigen reactie plaatsen"
  on public.comments for insert to authenticated with check (user_id = auth.uid());
create policy "Eigen reactie (of als host) verwijderen"
  on public.comments for delete to authenticated
  using (user_id = auth.uid() or public.is_host());


-- ---------------------------------------------------------------------
-- 4. FOTO-OPSLAG
-- Een "bucket" is een map voor bestanden. Alleen de host mag uploaden.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('photos', 'photos', true);

create policy "Host: foto's uploaden"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.is_host());

create policy "Host: foto's verwijderen"
  on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public.is_host());
