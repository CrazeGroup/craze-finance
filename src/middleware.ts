import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { decrypt } from './lib/auth';

const publicRoutes = ['/login', '/api/auth/login', '/api/auth/logout', '/api/auth/microsoft/login', '/api/auth/microsoft/callback', '/api/upload'];
const staticAssetRegex = /\.(ico|png|jpg|jpeg|svg|css|js|webp|woff|woff2|ttf|eot)$/;

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  
  // Allow public routes
  if (publicRoutes.includes(path) || staticAssetRegex.test(path) || path.startsWith('/_next')) {
    return NextResponse.next();
  }

  // Get token
  const token = request.cookies.get('auth-token')?.value;

  // If no token and not a public route, redirect to login
  if (!token) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  // Verify token
  try {
    const payload = await decrypt(token);
    
    // Authorization based on path
    const permissions: string[] = payload.permissions ? JSON.parse(payload.permissions) : [];
    const isAdmin = permissions.includes('configuracion') || permissions.includes('admin');
    
    // Check specific routes
    if (path.startsWith('/settings') && !isAdmin) {
      return NextResponse.redirect(new URL('/', request.url));
    }
    
    const rootPath = path.split('/')[1] || 'dashboard'; // '' becomes 'dashboard' (home)
    const normalizedRoot = rootPath === '' ? 'dashboard' : rootPath;
    
    // If they don't have permission for this module (and are not an API route like /api/dashboard), block
    // We allow API routes since they might be fetching data for allowed components, 
    // but in a strict setup we'd check API routes too. Let's keep it simple for now and just check main UI routes.
    const protectedUiRoutes = ['dashboard', 'riesgos', 'recobros', 'movimientos', 'pagos', 'cashflow', 'settings'];
    
    // Map routes to permission names
    const permissionMap: Record<string, string> = {
      'dashboard': 'dashboard',
      'riesgos': 'riesgos',
      'recobros': 'recobros',
      'movimientos': 'movimientos_abiertos',
      'pagos': 'pagos_proveedor',
      'cashflow': 'cashflow'
    };
    
    if (protectedUiRoutes.includes(normalizedRoot) && normalizedRoot !== 'settings') {
      const requiredPermission = permissionMap[normalizedRoot] || normalizedRoot;
      if (!permissions.includes(requiredPermission)) {
        return NextResponse.redirect(new URL('/', request.url));
      }
    }

    // Pass custom header with user info for API routes if needed
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-user-id', payload.id as string);
    requestHeaders.set('x-user-username', payload.username as string);
    requestHeaders.set('x-user-permissions', payload.permissions as string);

    return NextResponse.next({
      request: {
        headers: requestHeaders,
      }
    });
  } catch (error) {
    // Invalid token
    const response = NextResponse.redirect(new URL('/login', request.url));
    response.cookies.delete('auth-token');
    return response;
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
