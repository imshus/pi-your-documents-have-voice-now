export default function CallLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-5 py-6">{children}</div>
    </div>
  );
}
