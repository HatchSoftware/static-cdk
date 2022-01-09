import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import {HomePage} from './pages/home.page';

const routes: Routes = [
  {path: '', component: HomePage},
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }
