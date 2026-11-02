import { Routes } from '@angular/router';

export const ADMIN_ROUTES: Routes = [
  { path: '', redirectTo: 'users', pathMatch: 'full' },
  { path: 'users', loadComponent: () => import('./users-list.component').then((m) => m.UsersListComponent) },
  { path: 'roles', loadComponent: () => import('./roles-list.component').then((m) => m.RolesListComponent) },
  { path: 'assignment', loadComponent: () => import('./assignment-page.component').then((m) => m.AssignmentPageComponent) },
  { path: 'api-keys', loadComponent: () => import('./api-keys.component').then((m) => m.ApiKeysComponent) },
  { path: 'groups', loadComponent: () => import('./groups-list.component').then((m) => m.GroupsListComponent) },
];
