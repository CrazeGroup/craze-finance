import { redirect } from 'next/navigation';

// D-FORCE ahora es una pestaña de MAGAZINES
export default function DForceRedirect() {
  redirect('/magazines');
}
