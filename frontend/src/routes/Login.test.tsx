import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Login } from './Login';

describe('Login', () => {
  it('renders the sign-in form', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/login']}>
        <Login />
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { name: 'Connexion' })).toBeInTheDocument();
    const fields = container.querySelectorAll('md-outlined-text-field');
    expect(fields.length).toBe(2);
    expect(fields[0].getAttribute('label')).toBe('Adresse e-mail');
    expect(fields[1].getAttribute('label')).toBe('Mot de passe');
    expect(screen.getByText('Se connecter')).toBeInTheDocument();
  });

  it('switches to sign-up mode', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter initialEntries={['/login']}>
        <Login />
      </MemoryRouter>
    );
    await user.click(screen.getByText('Pas encore de compte ? Créer un compte'));
    expect(screen.getByRole('heading', { name: 'Créer un compte' })).toBeInTheDocument();
    const labels = Array.from(container.querySelectorAll('md-outlined-text-field')).map((f) =>
      f.getAttribute('label')
    );
    expect(labels).toEqual(['Nom complet', 'Adresse e-mail', 'Mot de passe']);
    expect(screen.getByText('Créer le compte')).toBeInTheDocument();
  });
});
