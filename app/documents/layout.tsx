export default function DocumentsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100" style={{ colorScheme: "dark" }}>
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-5 py-6">{children}</div>
    </div>
  );
}
