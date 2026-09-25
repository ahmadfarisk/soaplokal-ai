export default function PlaceholderPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-6 py-24 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      <div className="mx-auto max-w-md text-center">
        
        {/* Status Badge */}
        <div className="inline-flex items-center gap-2 rounded-full bg-zinc-200/60 px-3.5 py-1.5 text-xs font-medium text-zinc-800 dark:bg-zinc-800/60 dark:text-zinc-200 mb-6">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75"></span>
            <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500"></span>
          </span>
          Under Construction
        </div>

        {/* Main Heading */}
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Something awesome is coming.
        </h1>

        {/* Description */}
        <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
          We are currently working hard behind the scenes to bring this page to life. Check back soon for updates!
        </p>

      </div>
    </main>
  );
}