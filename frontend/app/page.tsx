import Link from "next/link";

export default function PlaceholderPage() {
  return (
    <main className="flex h-screen flex-col items-center justify-center bg-zinc-50 px-6 py-24 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      
      <Link className="hover:text-green-500" href="/model_manage">Manage models</Link>
      <Link className="hover:text-green-500" href="/soap_gen2">SOAP Note Gen</Link>
      <Link className="hover:text-green-500" href="/llm">LLM</Link>
      <Link className="hover:text-green-500" href="/llm_test">LLM test</Link>
      <Link className="hover:text-green-500" href="/stt">STT</Link>

    </main>
  );
}